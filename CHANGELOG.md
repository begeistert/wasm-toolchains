# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bootable clang-built Arduino firmware (pico-clang v0.2.0)** — a real
  Arduino-API sketch (`pinMode`/`digitalWrite`/`millis`/`delay`/`Serial.println`/
  `String`) now compiles with clang and links to a **genuinely bootable RP2040
  UF2**, entirely on the permissive stack: clang-assembled **boot2** (pico-sdk
  `boot2_w25q080.S`, BSD, CRC32-checksummed by the SDK's own `pad_checksum` — the
  bootrom accepts it, CRC byte-identical to the gcc build) + the **real upstream
  Arduino core** (ArduinoCore-API `Common`/`Print`/`String` and arduino-pico
  `stdlib_noniso.cpp`, clang-compiled) + a small permissive platform layer
  (`core/glue/`) over the RP2040 SIO/UART registers + picolibc + compiler-rt.
  `src/pico-clang/build-core.sh` builds it; `tools/pico-clang-wasm/verify-core-boot.cjs`
  proves the artifact is bootable (valid boot2 CRC + vector table). RP2350
  (armv8-m.main) compiles and links the same core with clang (valid ELF), but a
  *bootable* RP2350 image still needs the SDK's IMAGE_DEF block — see
  `docs/CLANG_PICO.md`. Ships `lib/<board>/libcore-arduino-clang.a` in the bundle.
  (Correction to the prior iteration: an SDK `pico_stdlib` blink reported as
  "clang-built" was actually `arm-none-eabi-gcc`; the bootable artifact here is
  genuinely clang-built and CRC-verified.)

- **Permissive clang Pico track (WIP)** (`pico-clang-toolchain` → `picoclangwasm.tar`,
  tags `pico-clang-v*`): a non-GPL replacement for the GPLv3 `pico-toolchain`
  (`src/arm-gcc`, GCC). `clang.wasm` replaces the GPL `cc1plus` (frontend +
  integrated assembler — no separate `as`), `lld.wasm` replaces GPL `ld`, and the
  two GPL/newlib runtime libraries are swapped for permissive ones:
  **compiler-rt** builtins (Apache-2.0-with-LLVM-exception) for libgcc and
  **picolibc** (BSD) for newlib. `src/pico-clang/` (build.sh + Dockerfile)
  cross-builds those TARGET (arm) libraries for both boards — `armv6-m`
  (RP2040/Cortex-M0+) and `armv8-m.main+dsp+fp` (RP2350/Cortex-M33); the wasm
  frontend/linker come from the `llvm` track. `tools/pico-clang-wasm/`
  (recipe-pico-clang.js + make-pico-clang-dist.cjs + verify-pico-clang.cjs)
  drives and validates the pipeline. **Verified**: `clang → lld → compiler-rt +
  picolibc` compiles and links a bare-metal blink to a valid ARM ELF
  (`e_machine = 40`) and UF2 (family `0xe48bff56`/`0xe48bff59`) for both boards
  (`tools/pico-clang-wasm/verify-pico-clang.cjs`, demo in `demo/`). **Not yet
  done**: the arduino-pico core recompiled with clang (the precompiled `core.a`
  the GCC track ships) — see `docs/CLANG_PICO.md`. AVR and ESP32-classic (Xtensa)
  stay on GCC (clang AVR is experimental; mainline clang has no Xtensa backend).

## [esp-v1.0.0 · llvm-v1.0.0 · pico-v1.1.0] - 2026-06-29

First release of the ESP32 (Xtensa) / ESP32-C3 (RISC-V) and LLVM IR tracks, plus
the Pico wireless overlay — alongside the build/publish modularization (declarative
target registry + reusable release workflow). The ESP32 Xtensa cc1plus is built as
the per-chip static `xtensa-esp32-elf` target (esp32 config baked in via the
arduino-esp32 overlay) so it needs no dynconfig plugin in WebAssembly; verified
flash-app harvest with a 146-header closure.

### Added

- **ESP32 tracks** (`esp32-toolchain` → `esp32wasm.tar`, `esp32c3-toolchain` →
  `esp32c3wasm.tar`, tags `esp-v*`): WebAssembly builds of the Espressif GNU
  toolchains for **ESP32** (Xtensa LX6) and **ESP32-C3** (RISC-V). One parametrized
  build context (`src/esp-gcc`, `TARGET` + Xtensa overlay), one harvest image
  (`src/espcap`, arduino-esp32), and a registry-driven `tools/esp-wasm/` (harvest +
  `make-esp-dist.cjs`). Each chip is a distinct ISA, so each ships its own
  `cc1plus.wasm` + binutils as an independent bundle on the shared `esp-v` track.
  ESP output is a flash app image (esptool offsets — bootloader/partitions/app —
  recorded in the manifest), not `.uf2`/`.hex`. Covered by
  `tools/esp-wasm/make-esp-dist.fixture.cjs`. (The Espressif gcc forks + Xtensa
  overlay and the ESP-IDF harvest are CI-validated; the bundle/registry/catalog
  wiring is unit-tested. The RISC-V chip can alternatively be driven by the LLVM IR
  backend.)

- **LLVM IR backend track** (`llvm-toolchain` → `llvmwasm.tar`, tags `llvm-v*`): a
  WebAssembly build of `llc`/`opt`/`lld`/`llvm-mc`/`llvm-objcopy` (LLVM 19.1.7) as
  a *single multi-target backend* — one `llc.wasm` compiles LLVM IR (`.ll`/`.bc`)
  to object/firmware for ARM, AArch64, RISC-V, AVR and experimental Xtensa, the
  target chosen by the IR triple or `-mtriple`. No per-arch wasm the way the GCC
  tracks need a `cc1plus` each. `src/llvm` (Dockerfile + build.sh, native tablegen
  → Emscripten cross), `tools/llvm-wasm/make-llvm-dist.cjs`, and
  `.github/workflows/release-llvm.yml`. Backs the upcoming ESP32 (Xtensa) /
  ESP32-C3 (RISC-V) targets from one backend. Covered by
  `tools/llvm-wasm/make-llvm-dist.fixture.cjs`. (The LLVM cross build itself is
  heavy and CI-validated; the bundle/catalog/registry wiring is unit-tested.)

- **Wireless overlay** (`pico-wireless` → `picowwasm.tar`): the Pico W boards
  (`pico_w`, `pico2w`) now ship as a separate catalog bundle that contains only
  the *delta* over the base `pico-toolchain` — the CYW43439 WiFi/BT `core.a` plus
  the lwip/bearssl link inputs and headers the non-W closure never opens (~9 MB),
  and no toolchain wasm. It extends the base (`requires: pico-toolchain` in
  `catalog.json`); both tarballs extract into one root. A host that doesn't target
  a W board never downloads the wireless firmware, and the 19 MB `cc1plus.wasm` is
  never duplicated. `make-pico-dist.cjs` builds base + overlay in one pass and
  computes the delta; `verify-pico.cjs` resolves files overlay-first so all four
  boards still verify flash-identical. `PICO_BOARDS` remains a single-bundle escape
  hatch. Covered by `tools/pico-wasm/make-pico-dist.fixture.cjs`.

### Changed

- **Reusable release workflow** (`.github/workflows/_release.yml`): the publish
  step — assemble `catalog.json` from the run's `dist-*-web` bundles (make-catalog
  is registry-driven) and create/upload the GitHub Release — was identical across
  `release-avr`/`release-pico`/`release-esp`/`release-llvm` save the tag prefix,
  title and notes. It now lives once as a `workflow_call`; each track passes
  `track`/`title`/`body`. A new track wires its release in ~6 lines. Release notes
  are passed via `env` (not inlined into the shell), so backticks/`$(...)` in the
  body can't break or inject.

- **Target registry** (`targets/*.json` + `tools/targets/registry.cjs`): the
  per-target board/bundle tables that were duplicated inline across
  `make-web-dist.cjs`, `harvest.cjs`, `make-pico-dist.cjs` and `make-catalog.cjs`
  now live in one declarative source of truth. Adding a target (a new arch, a new
  board, or a wireless overlay) is a data change, not a script edit. Build outputs
  are unchanged; `tools/targets/registry.test.cjs` guards the tables against
  drift. First step toward modularizing wireless variants as catalog overlays and
  onboarding new tracks (LLVM IR, ESP32 Xtensa, ESP32-C3).

## [1.0.0] - 2026-06-24

First public release, shipped as two GitHub Releases — **`avr-v1.0.0`** (AVR
toolchain) and **`pico-v1.0.0`** (ARM/Pico toolchain). WebAssembly builds of the
AVR and ARM (RP2040/RP2350) GNU toolchains, plus the orchestration and
distribution tooling to compile a real Arduino sketch to firmware entirely in a
browser, WKWebView, or Node.js.

### Added

- **AVR toolchain → WASM**: `avr-as` (`src/gas`), the binutils (`src/binutils`),
  `avr-ld` (`src/avr-ld`), and the C/C++ compiler proper `cc1`/`cc1plus`/`lto1`
  (`src/avr-gcc`, GCC 15.2). Targets ATmega328P (Uno/Nano), ATmega2560 (Mega) and
  ATtiny85.
- **ARM/Pico toolchain → WASM**: `cc1plus`, `arm-as`, `arm-ld`, `objcopy`
  (`src/arm-gcc`, GCC 14.3) plus a reproducible harvest image (`src/picocap`) for
  RP2040/RP2350 (`pico`, `pico2`, `pico_w`, `pico2w`).
- **JS orchestrators**: `tools/arduino-wasm` (AVR) and `tools/pico-wasm` (Pico)
  chain the WASM tools through a virtual filesystem — `.ino → cc1plus → as → ld →
  objcopy → .hex/.uf2` — the way `arduino-cli` / the gcc driver would.
- **Web bundle** (`make-web-dist.cjs` → `dist-web` → `avrwasm.tar`): a trimmed,
  brotli-compressed bundle (tools, per-board sysroot, Arduino core, libraries,
  `manifest.json`) shippable to iOS/WKWebView.
- **Library index** (`tools/lib-index/scan-libraries.cjs` → `header-lib-map.json`):
  a header→library map built from the Arduino Library Manager index for automatic
  on-device library resolution. In-bundle libraries (Wire, SPI, EEPROM,
  SoftwareSerial) are seeded first and win disambiguation for their headers.
- **Distribution catalog** (`tools/dist/make-catalog.cjs` → `catalog.json`): a
  versioned manifest with per-bundle URL + `sha256` + size for a host app to
  download, verify and cache.
- **CI** — two independent release tracks: `.github/workflows/release-avr.yml`
  (tags `avr-v*` → AVR Release with `avrwasm.tar` + `catalog.json`) and
  `.github/workflows/release-pico.yml` (tags `pico-v*` → Pico Release with
  `picowasm.tar` + `catalog.json`). Each validates its bundle before publishing and
  runs only on its own tag (or manual dispatch). The header→library map ships
  separately via the rolling `library-index` release (weekly cron), decoupled from
  the pinned toolchain versions.
- **Library index cron** (`.github/workflows/scan-libraries.yml`): weekly refresh
  of the header→library map to a rolling `library-index` release.
- **Examples**: `examples/arduino-web` (browser host) and
  `examples/maui-avr-assembler` (.NET MAUI / HybridWebView, MIT-licensed).
- **Docs**: `docs/AVR_TOOLCHAIN.md`, `docs/DESKTOP_AND_MAUI.md`,
  `docs/DISTRIBUTION.md`, `docs/LICENSING.md`.

### Notes

- The GPLv3 gcc/binutils blobs ship as runtime-downloaded artifacts via GitHub
  Releases, kept at arm's length from any consuming app. See
  [`docs/LICENSING.md`](docs/LICENSING.md).

[1.0.0]: https://github.com/begeistert/wasm-toolchains/releases/tag/avr-v1.0.0
