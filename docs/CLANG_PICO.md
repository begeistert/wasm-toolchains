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

## Bootable Arduino-API firmware, clang-built (v0.2.0)

A real Arduino-API sketch (`pinMode`/`digitalWrite`/`millis`/`delay`/`Serial.println`/
`String`) now compiles with clang and links to a **genuinely bootable RP2040
UF2** — verified by `tools/pico-clang-wasm/verify-core-boot.cjs`:

```
family:     0xe48bff56              OK
flash base: 0x10000000              OK
boot2 CRC:  calc=0x7a4eb274 stored=0x7a4eb274   OK (bootrom will accept)
vectors:    SP=0x20042000 reset=0x10000151      OK
PASS: clang-built RP2040 firmware is bootable
```

`src/pico-clang/build-core.sh` builds it end to end, all with clang + lld +
picolibc + compiler-rt:

- **boot2** — the pico-sdk `boot2_w25q080.S` (BSD), assembled by clang and
  CRC32-checksummed by the SDK's own `pad_checksum`. The bootrom validates boot2
  by CRC32-MPEG2 of the first 252 bytes; ours matches (`0x7a4eb274`) — and it is
  byte-identical to the gcc build, because boot2 asm is deterministic. This is
  what makes the image actually boot.
- **the genuine upstream Arduino core**: ArduinoCore-API `Common.cpp` /
  `Print.cpp` / `String.cpp` (the real `Serial.print`/`String`/`Stream`) and
  arduino-pico's `stdlib_noniso.cpp` (`ltoa`/`ultoa`/`dtostrf`) — compiled with
  clang for both armv6-m and armv8-m.
- a small permissive **platform layer** (`core/glue/`): `pinMode`/`digitalWrite`/
  `digitalRead`/`millis`/`delay` over the RP2040 SIO/UART registers, plus the
  freestanding C++ runtime bits arduino-pico normally takes from libstdc++
  (`operator new`/`delete`, a minimal `<limits>`), since we link no
  libc++/libstdc++.

### Shims needed to drive a STOCK clang (not the LLVM Embedded Toolchain for Arm)

The pico-sdk's own clang support targets the *LLVM Embedded Toolchain for Arm*
(which bundles a specific picolibc + compiler-rt + clang config). Driving a stock
Homebrew LLVM + the picolibc/compiler-rt from `build.sh` needs three documented
shims (all applied outside the SDK/core sources):

- `__printflike`/`__scanflike` appended to picolibc's `<sys/cdefs.h>` — newlib
  defines these; picolibc doesn't, and the SDK's `pico/stdio.h` uses them.
- `core/glue/pico_clang_compat.h` (force-included when building pico-sdk TUs) —
  clang reports `__has_builtin(__wfe/__sev/__wfi/__sevl)` true, so the SDK skips
  its inline fallback, but those ACLE intrinsics require `<arm_acle.h>` (which the
  SDK never includes); the shim defines exactly those and nothing the SDK already
  provides (`__nop`/`__dmb`/`__dsb`/`__isb`).
- `core/glue/cxxshim/<limits>` + `core/glue/cpp_support.cpp` — a freestanding
  `std::numeric_limits::epsilon` and `operator new/delete`, in lieu of libc++.

### RP2350 (Pico 2) — structurally valid Arm-Secure boot image, clang-built

RP2350 has no boot2: the bootrom scans the first 4 KB of flash for an **IMAGE_DEF
block loop**. `core/glue/rp2350_blocks.S` `#include`s the pico-sdk's own
`embedded_start_block.inc.S` / `embedded_end_block.inc.S` (BSD) and is assembled
with clang; `core/glue/link-rp2350.ld` places the block right after the vector
table (within the required first 4 KB) and closes the loop with an end block.
The same real Arduino-API sketch + ArduinoCore-API + picolibc + compiler-rt links
to `ardublink-pico2-clang-bootable.uf2` (family `0xe48bff59`, RP2350 Arm-Secure),
validated by `tools/pico-clang-wasm/verify-core-boot-rp2350.cjs`:

```
family: 0xe48bff59  block @0x3c: IMAGE_TYPE 0x42 flags=0x1021 (EXE|Secure|Arm|RP2350)
end block @0x534c: LOOP CLOSES OK   vectors: SP=0x20080000 reset=0x10000069
PASS: structurally valid Arm-Secure IMAGE_DEF block loop
```

The clang-assembled IMAGE_TYPE word is **byte-identical (`0x10210142`) to the
SDK/picotool's own** RP2350 output. **Caveat — honest scope:** this validates the
exact boot structure the RP2350 bootrom scans, and matches the SDK's format
byte-for-byte, but it is **structurally validated, not hardware-booted** (no
physical RP2350 in this environment).

### Still remaining / honestly not done

1. **Full pico-sdk build with a stock clang** (the `pico_arm_cortex_m*_clang`
   toolchain path, `PICO_COMPILER=`). clang compiles ~55/60 SDK TUs cleanly; the
   remaining gaps against pico-sdk 2.1.1 + LLVM 22 are: `__printflike` (fixed as
   above), the ACLE `__wfe`/`__sev` intrinsics (fixed as above), and
   `pico_atomic/atomic.c` + a `__wfe` redeclaration that still need work. The
   official LLVM-Embedded-Toolchain-for-Arm + a matching SDK version avoids these;
   the boot2 + minimal-runtime path in `build-core.sh` sidesteps the full SDK and
   is what produces the verified-bootable image above. **The full-SDK `pico_stdlib`
   (USB CDC `Serial`, TinyUSB, multicore, the FreeRTOS option) is future work.**
3. **Wire the host pipeline** — `recipe-pico-clang.js` already models the
   `clang`/`lld` argv; the browser/WebView pipeline and the iCircuit host need to
   call `clang.wasm` + `lld.wasm` (instead of `cc1plus`/`arm-as`/`arm-ld`) using
   the bundle manifest, and to ship the clang-built core objects as link inputs.

> **Correction:** an earlier iteration reported an SDK `pico_stdlib` blink as
> "clang-built"; it was actually built by `arm-none-eabi-gcc` (the SDK defaults to
> gcc unless `PICO_COMPILER=..._clang` is passed — not `PICO_TOOLCHAIN`). The
> bootable artifact documented here is genuinely clang-built and CRC-verified.

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
