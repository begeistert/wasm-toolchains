# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-24

First public release. WebAssembly builds of the AVR and ARM (RP2040/RP2350)
GNU toolchains, plus the orchestration and distribution tooling to compile a real
Arduino sketch to firmware entirely in a browser, WKWebView, or Node.js.

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
- **Unified CI** (`.github/workflows/release.yml`): builds every toolchain,
  assembles and validates both bundles, and on a `v*` tag publishes the catalog +
  tarballs to the GitHub Release from a single run.
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

[1.0.0]: https://github.com/begeistert/wasm-toolchains/releases/tag/v1.0.0
