"""Connect to Loona's Agora channel and report encoded-video callbacks."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agora.rtc.agora_base import (
    AgoraServiceConfig,
    AudioScenarioType,
    ClientRoleType,
    RTCConnConfig,
    RtcConnectionPublishConfig,
    VideoSubscriptionOptions,
)
from agora.rtc.agora_service import AgoraService
from agora.rtc.rtc_connection_observer import IRTCConnectionObserver
from agora.rtc.video_encoded_frame_observer import IVideoEncodedFrameObserver


CONFIG_PATH = Path(os.environ.get("LOONA_BRIDGE_CONFIG", "/ha_config/.loona/bridge-config.json"))
POLL_INTERVAL = 2.0
REPORT_INTERVAL = 5.0
STOP = threading.Event()


def log(message: str) -> None:
    print(f"[loona-native] {message}", flush=True)


@dataclass(frozen=True)
class SessionConfig:
    app_id: str
    channel: str
    token: str
    user_id: str
    signature: str


def load_session_config() -> SessionConfig | None:
    try:
        data = json.loads(CONFIG_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None

    required = ("app_id", "channel", "token", "user_id", "ws_port")
    if not all(data.get(key) not in (None, "", 0) for key in required):
        return None

    material = "\0".join(str(data[key]) for key in required).encode()
    return SessionConfig(
        app_id=str(data["app_id"]),
        channel=str(data["channel"]),
        token=str(data["token"]),
        user_id=str(data["user_id"]),
        signature=hashlib.sha256(material).hexdigest(),
    )


def wait_for_session(previous_signature: str | None) -> SessionConfig | None:
    while not STOP.is_set():
        config = load_session_config()
        if config and config.signature != previous_signature:
            return config
        time.sleep(POLL_INTERVAL)
    return None


class ConnectionObserver(IRTCConnectionObserver):
    def on_connecting(self, _connection: Any, _info: Any, reason: int) -> None:
        log(f"Agora connecting (reason={reason})")

    def on_connected(self, _connection: Any, _info: Any, reason: int) -> None:
        log(f"Agora connected (reason={reason})")

    def on_disconnected(self, _connection: Any, _info: Any, reason: int) -> None:
        log(f"Agora disconnected (reason={reason})")

    def on_connection_failure(self, _connection: Any, _info: Any, reason: int) -> None:
        log(f"Agora connection failed (reason={reason})")

    def on_user_joined(self, _connection: Any, user_id: str) -> None:
        log(f"Remote Agora user joined: {user_id}")

    def on_user_left(self, _connection: Any, user_id: str, reason: int) -> None:
        log(f"Remote Agora user left: {user_id} (reason={reason})")

    def on_error(self, _connection: Any, error_code: int, error_msg: str) -> None:
        log(f"Agora error {error_code}: {error_msg}")


class EncodedFrameObserver(IVideoEncodedFrameObserver):
    def __init__(self) -> None:
        self.frame_count = 0
        self.byte_count = 0
        self.first_frame: tuple[int, int, int, int] | None = None
        self._lock = threading.Lock()

    def on_encoded_video_frame(self, _uid: str, _buffer: bytes, length: int, info: Any) -> None:
        with self._lock:
            self.frame_count += 1
            self.byte_count += length
            if self.first_frame is None:
                self.first_frame = (
                    int(getattr(info, "codec_type", -1)),
                    int(getattr(info, "width", 0)),
                    int(getattr(info, "height", 0)),
                    int(getattr(info, "frame_type", -1)),
                )

    def snapshot(self) -> tuple[int, int, tuple[int, int, int, int] | None]:
        with self._lock:
            return self.frame_count, self.byte_count, self.first_frame


class NativeProbe:
    def __init__(self, service: AgoraService, config: SessionConfig) -> None:
        self._service = service
        self._config = config
        self._connection: Any = None
        self._frames = EncodedFrameObserver()
        self._connection_observer = ConnectionObserver()

    def start(self) -> bool:
        connection_config = RTCConnConfig(
            auto_subscribe_audio=0,
            auto_subscribe_video=0,
            client_role_type=ClientRoleType.CLIENT_ROLE_AUDIENCE,
        )
        publish_config = RtcConnectionPublishConfig(
            is_publish_audio=False,
            is_publish_video=False,
            audio_scenario=AudioScenarioType.AUDIO_SCENARIO_DEFAULT,
        )
        self._connection = self._service.create_rtc_connection(connection_config, publish_config)
        if self._connection is None:
            log("Agora connection object was not created")
            return False

        for label, result in (
            ("connection observer", self._connection.register_observer(self._connection_observer)),
            ("encoded-video observer", self._connection.register_video_encoded_frame_observer(self._frames)),
        ):
            if result != 0:
                log(f"Failed to register {label}: {result}")
                return False

        result = self._connection.connect(self._config.token, self._config.channel, self._config.user_id)
        if result != 0:
            log(f"Agora connect call failed: {result}")
            return False

        options = VideoSubscriptionOptions(encodedFrameOnly=True)
        result = self._connection.get_local_user().subscribe_all_video(options)
        if result != 0:
            log(f"Agora video subscription failed: {result}")
            return False

        log("Subscribed to encoded remote video")
        return True

    def run(self) -> None:
        last_report = 0.0
        while not STOP.is_set():
            current = load_session_config()
            if current is None or current.signature != self._config.signature:
                return
            now = time.monotonic()
            if now - last_report >= REPORT_INTERVAL:
                frames, total_bytes, first = self._frames.snapshot()
                if first is not None:
                    codec, width, height, frame_type = first
                    log(
                        f"encoded frames={frames} bytes={total_bytes} "
                        f"first=codec:{codec} {width}x{height} type:{frame_type}"
                    )
                else:
                    log("waiting for encoded remote video")
                last_report = now
            time.sleep(0.2)

    def close(self) -> None:
        if self._connection is None:
            return
        try:
            self._connection.disconnect()
        except Exception as exc:
            log(f"Agora disconnect failed: {exc}")
        try:
            self._connection.release()
        except Exception as exc:
            log(f"Agora release failed: {exc}")
        self._connection = None


def install_signal_handlers() -> None:
    def stop(_signal: int, _frame: Any) -> None:
        STOP.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)


def main() -> int:
    install_signal_handlers()
    log("native Agora probe started; waiting for a complete Loona camera session")
    config = wait_for_session(None)
    if config is None:
        return 0

    service_app_id = config.app_id
    service = AgoraService()
    initialized = service.initialize(
        AgoraServiceConfig(
            appid=config.app_id,
            enable_audio_processor=0,
            enable_audio_device=0,
            enable_video=1,
            log_path="/tmp/loona-native-agora.log",
            log_size=1024 * 1024,
        )
    )
    if initialized != 0:
        log(f"Agora service initialization failed: {initialized}")
        return 1

    previous_signature: str | None = None
    try:
        while not STOP.is_set():
            if config.app_id != service_app_id:
                log("Agora app ID changed; restart the native probe")
                break
            probe = NativeProbe(service, config)
            try:
                if probe.start():
                    probe.run()
            finally:
                probe.close()
            previous_signature = config.signature
            config = wait_for_session(previous_signature)
            if config is None:
                break
    finally:
        service.release()
        log("native Agora probe stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
