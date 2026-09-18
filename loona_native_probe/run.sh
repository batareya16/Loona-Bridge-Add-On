#!/bin/sh
set -eu

SDK_DIR="$(python3 -c 'import os, agora; print(os.path.join(os.path.dirname(agora.__file__), "agora_sdk"))')"
export LD_LIBRARY_PATH="$SDK_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec python3 -m native_probe.main
