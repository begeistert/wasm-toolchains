# Permissive clang toolchains — feasibility & the Pico (RP2040/RP2350) track

The GCC/binutils toolchains this repo ships are **GPLv3**. App Store distribution
terms are incompatible with GPLv3 (the VLC precedent), so those blobs are
runtime-downloaded from GitHub Releases and kept at arm's length from the app.
The goal here is to replace GCC with **clang/LLVM**
(Apache-2.0-with-LLVM-exception — permissive) wherever technically possible, so
the toolchain could eventually be bundled in the app with no GPL conflict.

A `clang.wasm` frontend already exists (`src/llvm` with `WITH_CLANG=1`, LLVM
19.1.7). `clang.wasm` replaces the GPL `cc1plus` **and** `gas` in one step (it has
an integrated assembler), and `lld.wasm` (the `llvm` track) replaces GPL `ld`.
What clang can NOT emit by itself are the **target runtime libraries** every
firmware link needs — those are what `src/pico-clang/` builds.

## Per-target feasibility

| Target | ISA | clang backend | Verdict |
|--------|-----|---------------|---------|
| **Pico — RP2040** | arm, thumbv6-m (Cortex-M0+) | ✅ mainline | **can replace GCC** — built + verified here |
| **Pico — RP2350** | arm, thumbv8-m.main (Cortex-M33) | ✅ mainline | **can replace GCC** — built + verified here |
| **ESP32-C3** | riscv32 (RV32IMC) | ✅ mainline | **feasible** (deferred) — same recipe, `riscv32` triple + rv32 compiler-rt/picolibc |
| **AVR** (Uno/Nano/Mega/ATtiny) | avr | ⚠️ experimental | **must stay GCC** — clang AVR backend is not production-ready |
| **ESP32 classic** | xtensa (LX6) | ❌ none in mainline | **must stay GCC** — mainline LLVM has no Xtensa backend; needs the `esp-clang` fork |

## The Pico track — what was built and proven

For a permissive Pico toolchain the missing pieces (none of which existed — only
the GPL GCC ones and a `wasm32-wasi` clang sysroot, which is the wrong target)
are, per board (`armv6-m` for RP2040, `armv8-m.main+dsp+fp` for RP2350):

1. **compiler-rt builtins** (Apache-2.0) — replaces libgcc. `__aeabi_uidiv`, soft
   float, etc. Built standalone from `compiler-rt-19.1.7.src/lib/builtins`
   (baremetal, `COMPILER_RT_OS_DIR=baremetal`, arch triple `armv6m`/`armv8m.main`).
2. **picolibc** (BSD) — replaces newlib as the libc. `libc.a` + `crt0` + headers
   + `picolibc.ld`, built with its meson cross-file pointed at clang + lld.

`src/pico-clang/build.sh` (and `Dockerfile`) build all four (2 boards × 2 libs).
`tools/pico-clang-wasm/verify-pico-clang.cjs` then drives the whole chain and
asserts the output is real ARM firmware:

```
PASS pico  (rp2040, thumbv6m-none-eabi):    ELF e_machine=40  UF2 family=0xe48bff56
PASS pico2 (rp2350, armv8m.main-none-eabi): ELF e_machine=40  UF2 family=0xe48bff59
```

i.e. `clang → lld → compiler-rt + picolibc` produces a valid ARM ELF
(`e_machine == 40`, EM_ARM) and a UF2 with the correct RP family id, for both
boards. The demo translation unit (`demo/blink.c`) deliberately pulls in a
picolibc symbol (`memset`) and a compiler-rt builtin (`__aeabi_uidiv`) so the
link exercises both libraries.

libc++ (permissive) is only needed if a sketch uses the C++ standard library;
Arduino sketches and the core mostly need only the freestanding C++ runtime
(`-fno-exceptions -fno-rtti`), which clang provides without libc++/libstdc++.

## What is NOT done yet (remaining work for a full Pico clang toolchain)

The GCC track ships a **precompiled arduino-pico `core.a`** (plus `libpico` /
lwip / bearssl and the boot2 second-stage) that a sketch links against; a build
only recompiles the one sketch translation unit and relinks. The clang track
still lacks the clang-compiled equivalents:

1. **Recompile the arduino-pico core with clang** — the pico-sdk + arduino-pico
   core (Cortex-M0+/M33), producing `core.a` for each board with clang instead of
   arm-none-eabi-gcc. This is the large remaining piece. The SDK is
   clang-friendly but has GCC-isms (inline asm, linker-script assumptions, the
   RP2350 TrustZone/boot flow) to work through.
2. **boot2 + the real flash memory map / linker script** — the demo uses a
   minimal linker script; a bootable image needs the checksummed second-stage
   bootloader at flash start and the SDK's linker script.
3. **Wire the host pipeline** — `recipe-pico-clang.js` already models the
   `clang`/`lld` argv; the browser/WebView pipeline and the iCircuit host need to
   call `clang.wasm` + `lld.wasm` (instead of `cc1plus`/`arm-as`/`arm-ld`) using
   the bundle manifest.

### Precise commands to (re)produce the permissive ARM libs with a native LLVM

Any host LLVM ≥ 17 with the ARM backend (validated with Homebrew LLVM and the
pinned 19.1.7). `meson`, `cmake`, `ninja` required.

```bash
# compiler-rt builtins + picolibc for both boards -> $OUT/lib/{pico,pico2}/
LLVM_BIN=/opt/homebrew/opt/llvm/bin \
COMPILER_RT_SRC=/path/to/compiler-rt-19.1.7.src \
LLVM_CMAKE_DIR=/opt/homebrew/opt/llvm/lib/cmake/llvm \
PICOLIBC_SRC=/path/to/picolibc \
OUT=dist-pico-clang-armlibs \
  src/pico-clang/build.sh
# or fully hermetic:  docker buildx build --output=type=local,dest=dist-pico-clang-armlibs src/pico-clang

# assemble the bundle (needs the prebuilt clang.wasm + lld.wasm/llvm-objcopy.wasm)
PICO_CLANG_ARMLIBS=dist-pico-clang-armlibs \
CLANG_WASM_DIR=/path/to/clang \
LLVM_WASM_DIR=/path/to/llvm/tools \
  node tools/pico-clang-wasm/make-pico-clang-dist.cjs dist-pico-clang-web

# prove it
node tools/pico-clang-wasm/verify-pico-clang.cjs /opt/homebrew/opt/llvm/bin dist-pico-clang-armlibs
```

### In-repo blocker note

`clang.wasm` / `lld.wasm` themselves are built by `src/llvm` (Emscripten,
`WITH_CLANG=1`) and are large/multi-hour; that build needs **Emscripten** (not
present in every dev environment). The permissive ARM libraries in this track are
target (arm) static libs and build with any native LLVM — no Emscripten needed —
which is why they can be produced and verified independently of the wasm build.
