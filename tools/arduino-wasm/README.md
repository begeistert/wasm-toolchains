# arduino-wasm — compile real Arduino sketches to a valid binary, in WASM

This completes the AVR toolchain: it adds the **C/C++ compiler proper**
(`cc1` / `cc1plus`, compiled to WebAssembly from GCC 15.2) and a JS orchestrator
that drives the full Arduino compile pipeline — the same work `arduino-cli compile`
does, reimplemented in JS because a browser/WKWebView has no `fork`/`exec`.

```
.ino ─cc1plus─► .s ─avr-as─► .o ┐
core/*.cpp,*.c ─────────────────┼─avr-ar─► core.a ┐
                                │                  ├─avr-ld─► .elf ─objcopy─► .hex
sketch .o ───────────────────────┘                 │
        crt<mcu>.o + libgcc.a + libc.a + lib<mcu>.a ┘
```

## Why the compiler had to be split out

Desktop `avr-gcc` is a *driver* that fork/exec's `cc1plus`, `as`, then `ld`.
Emscripten has no fork/exec, so the driver can't run in a browser. The compiler
*proper* (`cc1`/`cc1plus`) is a single in-process program and ports cleanly — so
we ship it as a WASM module and let JS do the chaining the driver used to do.

## Building the toolchain

```bash
docker buildx build --output=type=local,dest=dist-avr-gcc src/avr-gcc
```

Produces `dist-avr-gcc/`:
- `cc1.js`, `cc1plus.js` — the AVR compilers, WASM (GCC 15.2, single-threaded
  for WKWebView, no SharedArrayBuffer needed)
- `specs/cc1plus-<mcu>.txt`, `specs/link-<mcu>.txt` — the exact argv the native
  15.2 driver emits per device; the orchestrator mines the device flags
  (`-mmcu=avr5`, `-D__AVR_*`, `-Tdata`, …) from these
- `sysroot/` — target runtime the linker consumes: avr-libc, `libgcc.a`
  (from the matching native 15.2 build → ABI-identical), headers, ldscripts

Add `avr-as.js`, `avr-ld.js`, `ar.js`, `objcopy.js` (from the binutils builds)
to the same dir.

## Compiling a sketch (Node — the test harness)

```bash
node tools/arduino-wasm/build-sketch.cjs dist-avr-gcc src/arduino-core uno \
     examples/sketches/HelloSerial/HelloSerial.ino out.hex

# heavier sketch with libraries:
node tools/arduino-wasm/build-sketch.cjs dist-avr-gcc src/arduino-core uno \
     examples/sketches/HeavyDemo/HeavyDemo.ino out.hex \
     --lib libraries/Wire --lib libraries/SPI --lib libraries/SoftwareSerial
```

Supported sketch features: `.ino` preprocessing with **ctags-style forward
prototype generation** (call-before-definition works), **multiple libraries**
(`--lib DIR`, both flat and `src/`-layout), and **`.S` assembler sources** (core
`wiring_pulse.S`, preprocessed via `cc1 -E`). `recipe.js` holds the shared
build logic (board table, flags, prototype generation, argv builders) used by
both the Node and browser orchestrators.

## Validating the binary on the AVR-8 simulator

The produced HEX is loaded into **Avr8Sharp** and actually run:

```bash
cd tools/arduino-wasm/Avr8Validate
dotnet run -c Release -- out.hex HELLO_AVR_WASM
# → RESULT: PASS — WASM-compiled binary runs on the AVR-8 simulator.
```

## iOS / WKWebView deployment

```bash
node tools/arduino-wasm/make-web-dist.cjs      # -> dist-web/
```

Efficiency: cc1/cc1plus are built **without `-sSINGLE_FILE`** (separate `.wasm`,
no +33% base64) and `make-web-dist` brotli-compresses every large artifact.
Result: the compilers drop from ~39 MB (single-file) to ~9 MB brotli, and the
whole **iOS ship size is ~31 MB** (vs ~290 MB raw build sidecar). Serve the
`.br` files with `Content-Encoding: br` from the native host
(`WKURLSchemeHandler`) so the browser inflates them transparently; raw copies
stay alongside for hosts that don't.

`dist-web/` holds the tool modules (+ `.wasm` + `.br`), `manifest.json`, the
trimmed per-board sysroot, the Arduino core, and the bundled `libraries/`.
`examples/arduino-web/index.html` loads the WASM factories + `recipe.js`;
`arduino-pipeline.js` exposes
`window.compileArduino({ source, board, libraries })` for the native host.
It is the browser twin of `compiler.cjs` — same `recipe.js`, same WASM modules,
and it produces **byte-identical binaries** to the Node harness (verified).

## LTO (`--lto`) — works and reduces size (Node), via `-fwhole-program`

LTO is implemented and **reduces code size on real sketches** (HeavyDemo:
21.6 KB → 18.1 KB, −16%). The toolchain is built `--enable-lto`; `--lto`
compiles every unit to a slim GIMPLE object, then runs **`lto1` in a single
partition** (`-flto-partition=none -flinker-output=exec`) to merge them into one
real-code object that `avr-as` assembles and `avr-ld` links.

The non-obvious part: real LTO's dead-code elimination normally depends on the
**`-fresolution` symbol map** produced by the GNU linker **plugin**, which
wasm-binutils `ld` can't `dlopen`. We reverse-engineered the resolution format
(the per-object id is the `.gnu.lto_.symtab.<id>` section-name suffix; the
per-symbol index is an internal counter `lto1` validates strictly — a mismatch
aborts) and confirmed a hand-fed resolution does precise DCE. Rather than
synthesize that map, we use **`-fwhole-program`**, which gets the same effect
without it: it treats the merged set as the whole program, so everything except
`main` and `externally_visible` symbols (Arduino ISRs are declared
`used,externally_visible`, so they survive) becomes internal and eligible for
removal. `-ffunction/-fdata-sections` + `--gc-sections` then drop the dead code.
On tiny sketches LTO can be marginally larger (inlining overhead); it pays off
on real/heavy code, which is where flash pressure matters.

**Status:** the Node path (`build-sketch.cjs --lto`) is validated end-to-end on
the simulator. The browser orchestrator (`arduino-pipeline.js`) wires the same
steps but currently mis-compiles some units under LTO (lto1 drops internal
symbols — even Node's `combineLto` fails on the browser-produced objects, which
differ only in embedded source paths / derived hashes); the cause is still under
investigation, so browser LTO is labelled experimental. Browser **non-LTO** is
fully validated and produces byte-identical output to the Node harness.

## Other divergences from arduino-cli

- **`-fno-rtti`**: no libstdc++/libsupc++ shipped, so RTTI `type_info` vtables
  aren't available. Arduino code never uses `typeid`/`dynamic_cast`.

Memory note for iOS: `cc1plus.wasm` is ~18 MB and needs a few hundred MB of
heap to compile; verify against the target device's WKWebView memory limit
(`MAXIMUM_MEMORY=2GB` in the build, but the device ceiling is lower).
