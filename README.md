# wasm-toolchains

Embedded GNU toolchains — the AVR and ARM (RP2040/RP2350) compilers, assemblers,
linkers and binutils — compiled to **WebAssembly** with [Emscripten](https://emscripten.org/),
so a real Arduino sketch can be compiled to firmware **entirely in a browser,
WKWebView, or Node.js**, with no native toolchain installed.

Each tool is an Emscripten module (`.js` loader + `.wasm`, or a single-file `.js`)
driven through a data interface (argv + a virtual filesystem). A small JS
orchestrator chains them the way `arduino-cli` / the gcc driver would —
`.ino → cc1plus → as → ld → objcopy → .hex/.uf2` — because a browser has no
`fork`/`exec`.

## What's here

| Toolchain | Source | Targets | Output bundle |
|-----------|--------|---------|---------------|
| **AVR** | `src/gas`, `src/binutils`, `src/avr-ld`, `src/avr-gcc` (GCC 15.2) | Uno/Nano (ATmega328P), Mega (ATmega2560), ATtiny85 | `dist-web/` → `avrwasm.tar` |
| **ARM/Pico** | `src/arm-gcc` (GCC 14.3) + `src/picocap` harvest | RP2040/RP2350 — `pico`, `pico2` | `dist-pico-web/` → `picowasm.tar` |
| **Pico W** (overlay) | same toolchain, delta only (CYW43 WiFi/BT) | `pico_w`, `pico2w` | `dist-pico-wireless/` → `picowwasm.tar` |
| **ESP32** | `src/esp-gcc` (Espressif gcc fork) + `src/espcap` harvest | ESP32 (Xtensa LX6) | `dist-esp32-web/` → `esp32wasm.tar` |
| **ESP32-C3** | `src/esp-gcc` (RISC-V target) + `src/espcap` harvest | ESP32-C3 (RV32IMC) | `dist-esp32c3-web/` → `esp32c3wasm.tar` |
| **LLVM** | `src/llvm` (LLVM 19.1.7) | LLVM IR (`.ll`/`.bc`) → ARM/AArch64/RISC-V/AVR/Xtensa | `dist-llvm-web/` → `llvmwasm.tar` |

Plus the Arduino core (`src/arduino-core`), bundled libraries (`libraries/`), a
weekly **library index** (`tools/lib-index` → `header-lib-map.json`) for automatic
on-device library resolution, and a versioned **catalog** (`tools/dist/make-catalog.cjs`
→ `catalog.json`) a host app reads to download + verify + cache the bundles.

## Distribution

Everything ships as **runtime-downloaded blobs via GitHub Releases**, not bundled
in the consuming app — this keeps the ~200 MB of GPL toolchains out of the app and
keeps the GPLv3 gcc/binutils at arm's length from proprietary hosts. See
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) and [`docs/LICENSING.md`](docs/LICENSING.md).

## Building locally

Docker + Node are the only dependencies.

```bash
# AVR toolchain
docker buildx build --output=type=local,dest=dist-gas       src/gas
docker buildx build --output=type=local,dest=dist-binutils  src/binutils
docker buildx build --output=type=local,dest=dist-avr-ld    src/avr-ld
docker buildx build --output=type=local,dest=dist-avr-gcc   src/avr-gcc   # heavy (~hours)
# merge the binutils tools into dist-avr-gcc/, then:
node tools/arduino-wasm/make-web-dist.cjs                                  # -> dist-web/

# ARM/Pico toolchain
docker buildx build --output=type=local,dest=dist-arm-gcc   src/arm-gcc   # heavy (~hours)
docker build -t picocap:latest src/picocap
node tools/pico-wasm/harvest.cjs dist-pico-web
node tools/pico-wasm/verify-pico.cjs dist-pico-web
```

CI does all of this in independent release tracks —
[`release-avr.yml`](.github/workflows/release-avr.yml) (tags `avr-v*`),
[`release-pico.yml`](.github/workflows/release-pico.yml) (tags `pico-v*`, base +
wireless overlay), [`release-esp.yml`](.github/workflows/release-esp.yml) (tags
`esp-v*`, ESP32 Xtensa + ESP32-C3 RISC-V) and
[`release-llvm.yml`](.github/workflows/release-llvm.yml) (tags `llvm-v*`) — each
publishing its own GitHub Release. The publishable bundles
are declared once in [`targets/`](targets/) and read by every build/catalog
script via [`tools/targets/registry.cjs`](tools/targets/registry.cjs).

## Compiling a sketch (Node harness)

```bash
node tools/arduino-wasm/build-sketch.cjs dist-avr-gcc src/arduino-core uno \
     examples/sketches/HelloSerial/HelloSerial.ino out.hex
```

The produced HEX is validated on the AVR-8 simulator via
`tools/arduino-wasm/Avr8Validate`.

## Supported AVR devices

| Label | MCU | avr-libc arch family |
|-------|-----|----------------------|
| `arduino-uno` / `arduino-nano` | ATmega328P | avr5 |
| `arduino-mega` | ATmega2560 | avr6 |
| `attiny85` | ATtiny85 | avr25 |

To add more, edit [`src/avr-ld/devices.sh`](src/avr-ld/devices.sh) and the board
table in [`tools/arduino-wasm/recipe.js`](tools/arduino-wasm/recipe.js), then rebuild.

## Examples

| Path | Description |
|------|-------------|
| [`examples/arduino-web`](examples/arduino-web) | Browser host — loads the WASM factories + `recipe.js` and exposes `window.compileArduino({ source, board, libraries })`. |
| [`examples/maui-avr-assembler`](examples/maui-avr-assembler) | .NET MAUI app (iOS / Mac Catalyst / Android) running the full pipeline inside a `HybridWebView`. |

## License

GPL-3.0-or-later — in accordance with the license of GNU Binutils / GCC.

The host-side example apps are separate: `examples/maui-avr-assembler` is
**MIT-licensed** (it drives the toolchain at arm's length and ships no GPL
compiler code). See [`docs/LICENSING.md`](docs/LICENSING.md).
