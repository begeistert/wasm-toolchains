# picocap — reproducible harvest environment for the RP2040/RP2350 (Pico)
# on-device compiler bundle. Ships arduino-cli + the Earle-Philhower arduino-pico
# core + the Tier-1 libraries pinned, so `tools/pico-wasm/harvest.sh` can capture
# the exact cc1plus/ld invocations, header closure and precompiled objects a real
# arduino-cli build produces. Pinned versions keep the bundle byte-reproducible.
FROM ubuntu:22.04

ARG ARDUINO_CLI_VERSION=1.1.1
ARG PICO_CORE_VERSION=5.6.0
# Tier-1 libraries (the ones iCircuit reimplements as C# shims), name@version.
ARG TIER1_LIBS="Adafruit NeoPixel@1.15.5,Keypad@3.1.1,DHT sensor library@1.4.7,Adafruit PWM Servo Driver Library@3.0.3,Adafruit MCP9808 Library@2.0.2"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates python3 git tar xz-utils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# arduino-cli
RUN curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_Linux_64bit.tar.gz" \
      | tar xz -C /usr/local/bin arduino-cli

# arduino-pico core (pinned) + Tier-1 libraries (pinned)
RUN arduino-cli config init && \
    arduino-cli config add board_manager.additional_urls \
      https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json && \
    arduino-cli core update-index && \
    arduino-cli core install "rp2040:rp2040@${PICO_CORE_VERSION}" && \
    IFS=','; for lib in ${TIER1_LIBS}; do arduino-cli lib install "${lib}"; done && \
    arduino-cli cache clean

WORKDIR /work
