ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        dumb-init \
        python3 \
        python3-pip \
        python3-setuptools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loona-native-probe

COPY requirements.txt ./
# The package's PEP 517 wheel omits Agora's native runtime. Its source installer
# downloads the matching Linux SDK, including the aarch64 library.
RUN python3 -m pip download --no-cache-dir --no-deps --no-binary :all: -r requirements.txt -d /tmp/agora \
    && tar -xzf /tmp/agora/agora_python_server_sdk-2.4.9.tar.gz -C /tmp/agora \
    && cd /tmp/agora/agora_python_server_sdk-2.4.9 \
    && python3 setup.py install \
    && rm -rf /tmp/agora

COPY native_probe ./native_probe
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "-g", "--", "/run.sh"]
