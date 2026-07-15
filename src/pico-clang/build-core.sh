#!/bin/bash
# build-core.sh — build a GENUINELY BOOTABLE RP2040 firmware from a real
# Arduino-API sketch, entirely with the permissive clang stack:
#
#   clang (frontend+integrated-as)  ->  ld.lld  ->  picolibc + compiler-rt
#   + the REAL upstream Arduino core code:
#       * arduino-pico's boot2 (pico-sdk boot2_w25q080.S, BSD) — assembled with
#         clang and CRC32-checksummed by the SDK's own pad_checksum, so the
#         RP2040 bootrom accepts it (the checksum is byte-identical to the gcc
#         build — boot2 asm is deterministic).
#       * ArduinoCore-API Common.cpp / Print.cpp / String.cpp (the genuine
#         Serial.print / String / Stream implementation) — compiled with clang.
#       * arduino-pico's stdlib_noniso.cpp (ltoa/ultoa/dtostrf) — compiled with clang.
#   + a small permissive platform layer (glue/) implementing pinMode/digitalWrite/
#     millis/delay over the RP2040 SIO/UART registers, plus the freestanding C++
#     bits arduino-pico normally takes from libstdc++ (operator new/delete, a
#     minimal <limits>) since we link no libc++/libstdc++.
#
# This is the on-device equivalent of the GPL gcc track's precompiled core.a,
# but permissive and clang-built. The output UF2 boots on real RP2040 hardware
# (boot2 CRC valid, vector table at 0x10000100, family 0xe48bff56).
#
# NOTE the shims this needs when driving a STOCK clang (not the LLVM Embedded
# Toolchain for Arm) — all documented in docs/CLANG_PICO.md:
#   * __printflike/__scanflike added to picolibc's <sys/cdefs.h> (newlib-only macros);
#   * glue/pico_clang_compat.h force-included when building pico-sdk TUs (ACLE
#     __wfe/__sev intrinsics clang reports via __has_builtin but needs <arm_acle.h> for);
#   * glue/cxxshim/<limits> + glue/cpp_support.cpp (freestanding C++ runtime bits).
#
# Inputs (env):
#   TC             the LLVM-embedded-toolchain-style root from build.sh's toolchain
#                  (bin/clang* + lib/clang-runtimes/arm-none-eabi/<rt>/), OR set
#                  LLVM_BIN + SYSROOT_V6M directly.
#   PICO_SDK       pico-sdk checkout (for boot2 + pad_checksum)
#   ARDUINO_PICO   arduino-pico checkout (its ArduinoCore-API submodule initialised)
#   GLUE           this repo's tools/pico-clang-wasm/core/glue
#   SKETCH         the sketch .cpp (Arduino setup()/loop() or a main())
#   OUT            output dir (default ./out-core)
set -xe -o pipefail

TC=${TC:?set TC to the pico-clang toolchain root}
PICO_SDK=${PICO_SDK:?set PICO_SDK}
ARDUINO_PICO=${ARDUINO_PICO:?set ARDUINO_PICO}
GLUE=${GLUE:?set GLUE to tools/pico-clang-wasm/core/glue}
SKETCH=${SKETCH:?set SKETCH to the sketch .cpp}
OUT=${OUT:-./out-core}
LLVM_BIN=${LLVM_BIN:-$TC/bin}
SR=${SYSROOT_V6M:-$TC/lib/clang-runtimes/arm-none-eabi/armv6m_soft_nofp}
API="$ARDUINO_PICO/ArduinoCore-API/api"
CORE="$ARDUINO_PICO/cores/rp2040"
B2="$PICO_SDK/src/rp2040/boot_stage2"

mkdir -p "$OUT"; OUT=$(realpath "$OUT")
CF="--target=armv6m-none-eabi -mcpu=cortex-m0plus -mfloat-abi=soft -Os -ffreestanding \
    -nostdlib -nostdinc++ -fno-exceptions -fno-rtti -fno-threadsafe-statics \
    -I$GLUE -I$GLUE/cxxshim -I$API -I$API/deprecated-avr-comp --sysroot=$SR"

# ── 1. boot2 (BSD) — assemble with clang, CRC32 via the SDK's pad_checksum ──
B2INC="-I$B2/include -I$B2/asminclude -I$PICO_SDK/src/rp2040/hardware_regs/include \
  -I$PICO_SDK/src/rp2_common/hardware_base/include -I$PICO_SDK/src/common/pico_base_headers/include \
  -I$PICO_SDK/src/boards/include -I$PICO_SDK/src/rp2040/pico_platform/include \
  -I$PICO_SDK/src/rp2_common/pico_platform_compiler/include \
  -I$PICO_SDK/src/rp2_common/pico_platform_panic/include \
  -I$PICO_SDK/src/rp2_common/pico_platform_sections/include"
"$LLVM_BIN/clang" --target=armv6m-none-eabi -mcpu=cortex-m0plus -mfloat-abi=soft -nostdlib \
  $B2INC -c "$B2/compile_time_choice.S" -o "$OUT/bs2.o"
"$LLVM_BIN/ld.lld" -T "$B2/boot_stage2.ld" --build-id=none -o "$OUT/bs2.elf" "$OUT/bs2.o"
"$LLVM_BIN/llvm-objcopy" -O binary "$OUT/bs2.elf" "$OUT/bs2.bin"
python3 "$B2/pad_checksum" -s 0xffffffff "$OUT/bs2.bin" "$OUT/boot2.S"

# ── 2. the real Arduino core + glue + sketch ────────────────────────────────
"$LLVM_BIN/clang"   $CF -c "$OUT/boot2.S"        -o "$OUT/boot2.o"
"$LLVM_BIN/clang"   $CF -c "$GLUE/startup.c"     -o "$OUT/startup.o"
for src in "$GLUE/platform.cpp" "$GLUE/cpp_support.cpp" "$SKETCH" \
           "$API/Common.cpp" "$API/Print.cpp" "$API/String.cpp" "$CORE/stdlib_noniso.cpp"; do
  o="$OUT/$(basename "${src%.*}").o"
  "$LLVM_BIN/clang++" $CF -std=gnu++17 -c "$src" -o "$o"
done

# ── 3. link into a bootable image + UF2 ─────────────────────────────────────
"$LLVM_BIN/ld.lld" -T "$GLUE/link.ld" --gc-sections -o "$OUT/firmware.elf" \
  "$OUT"/boot2.o "$OUT"/startup.o "$OUT"/platform.o "$OUT"/cpp_support.o \
  "$OUT/$(basename "${SKETCH%.*}").o" "$OUT"/Common.o "$OUT"/Print.o "$OUT"/String.o \
  "$OUT"/stdlib_noniso.o -L"$SR/lib" -lc "$SR/lib/libclang_rt.builtins.a"
"$LLVM_BIN/llvm-objcopy" -O binary "$OUT/firmware.elf" "$OUT/firmware.bin"
node "$(dirname "$0")/../../tools/pico-clang-wasm/bin2uf2.cjs" "$OUT/firmware.bin" 0xe48bff56 "$OUT/firmware.uf2"
echo "=== bootable RP2040 firmware (clang) -> $OUT/firmware.uf2 ==="
