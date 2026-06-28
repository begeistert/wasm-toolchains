# espcap — reproducible harvest environment for the ESP32 (Xtensa) + ESP32-C3
# (RISC-V) on-device compiler bundles. Twin of src/picocap: ships arduino-cli +
# the arduino-esp32 core + the Tier-1 libraries pinned, so tools/esp-wasm/harvest.sh
# can capture the exact cc1plus/ld invocations, header closure and precompiled
# objects a real arduino-cli build produces — for every esp board in one image.
#
# NOTE: arduino-esp32 is ESP-IDF based; a sketch build links a precompiled core +
# libs (the harvestable part, same as arduino-pico) but the FLASH IMAGE is assembled
# by esptool (bootloader @ flash[bootloader] + partition table @ 0x8000 + app @
# 0x10000), not a single .uf2/.hex. harvest.sh captures the app .bin + the offsets;
# make-esp-dist records them in the manifest so the host/emulator can place the app.
FROM ubuntu:22.04

ARG ARDUINO_CLI_VERSION=1.1.1
ARG ESP32_CORE_VERSION=3.1.1
# Tier-1 libraries (name@version), same set the other bundles harvest.
ARG TIER1_LIBS="Adafruit NeoPixel@1.15.5,Keypad@3.1.1,DHT sensor library@1.4.7,Adafruit PWM Servo Driver Library@3.0.3,Adafruit MCP9808 Library@2.0.2"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates python3 python3-pip git tar xz-utils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# arduino-cli
RUN curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_Linux_64bit.tar.gz" \
      | tar xz -C /usr/local/bin arduino-cli

# arduino-esp32 core (pinned) + Tier-1 libraries (pinned). The core install pulls
# the Espressif xtensa-esp-elf + riscv32-esp-elf toolchains + the precompiled
# per-chip core archives we harvest as the link sidecar.
RUN arduino-cli config init && \
    arduino-cli config add board_manager.additional_urls \
      https://espressif.github.io/arduino-esp32/package_esp32_index.json && \
    arduino-cli core update-index && \
    arduino-cli core install "esp32:esp32@${ESP32_CORE_VERSION}" && \
    IFS=','; for lib in ${TIER1_LIBS}; do arduino-cli lib install "${lib}"; done && \
    arduino-cli cache clean

WORKDIR /work
