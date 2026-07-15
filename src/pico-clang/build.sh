#!/bin/bash
# Build the PERMISSIVE (Apache-2.0-with-LLVM-exception / BSD) ARM-target runtime
# libraries a clang toolchain needs to produce RP2040 / RP2350 firmware — the
# pieces the prebuilt clang.wasm + lld.wasm can NOT emit by themselves:
#
#   * compiler-rt builtins  (armv6m  -> Cortex-M0+ / RP2040)
#   * compiler-rt builtins  (armv8m.main -> Cortex-M33 / RP2350)
#   * picolibc  (libc.a + crt0 + headers + picolibc.ld) for each of the two
#
# clang.wasm already replaces the GPL cc1plus (frontend + integrated-as) and
# lld.wasm replaces GPL ld; the only missing, permissively-licensed link inputs
# are the target libc and the compiler builtins. GCC ships libgcc (GPL + runtime
# exception) and newlib; the clang stack replaces those with compiler-rt
# (Apache-2.0) and picolibc (BSD), so the whole ARM toolchain becomes permissive.
#
# Unlike the GCC tracks this is NOT a WebAssembly build: these are TARGET (arm)
# static libraries, cross-compiled by a host LLVM. They are architecture-neutral
# link inputs — the clang/lld that consume them is the wasm one from the llvm
# track. Any host LLVM >= 17 with the ARM backend works (validated with LLVM
# 19.1.7, matching the pinned clang.wasm, and LLVM 22).
#
# Inputs (env):
#   LLVM_BIN         dir with clang/llvm-ar/llvm-nm/llvm-ranlib/llvm-strip + ld.lld
#   COMPILER_RT_SRC  path to compiler-rt-<ver>.src  (lib/builtins is the build dir)
#   LLVM_CMAKE_DIR   path to an LLVM install's lib/cmake/llvm (AddLLVM.cmake etc.)
#   PICOLIBC_SRC     path to a picolibc checkout
#   OUT              output dir (default /dist)
set -xe -o pipefail

LLVM_BIN=${LLVM_BIN:?set LLVM_BIN to an LLVM bin dir with clang + llvm-ar + ld.lld}
COMPILER_RT_SRC=${COMPILER_RT_SRC:?set COMPILER_RT_SRC to compiler-rt-<ver>.src}
LLVM_CMAKE_DIR=${LLVM_CMAKE_DIR:?set LLVM_CMAKE_DIR to <llvm-install>/lib/cmake/llvm}
PICOLIBC_SRC=${PICOLIBC_SRC:?set PICOLIBC_SRC to a picolibc checkout}
OUT=${OUT:-/dist}
LD_LLD=${LD_LLD:-$LLVM_BIN/ld.lld}
MESON=${MESON:-meson}

mkdir -p "$OUT"; OUT=$(realpath "$OUT")
WORK=$(mktemp -d)

# compiler-rt's standalone builtins build infers a sibling llvm/cmake/modules and
# mocks LLVMConfig from it — point that at a real LLVM install's cmake dir.
mkdir -p "$WORK/llvm/cmake"; ln -sfn "$LLVM_CMAKE_DIR" "$WORK/llvm/cmake/modules"

# ── boards: key | clang triple (arm-prefixed so compiler-rt names the arch) |
#           cpu/arch cflags (matches targets/pico.json asFlags) ──────────────
build_builtins() {  # <outkey> <rt-triple> <cflags...>
  local key="$1" triple="$2"; shift 2; local cflags="$*"
  cmake -G Ninja -S "$COMPILER_RT_SRC/lib/builtins" -B "$WORK/rt-$key" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_SYSTEM_PROCESSOR=arm \
    -DCMAKE_C_COMPILER="$LLVM_BIN/clang" -DCMAKE_ASM_COMPILER="$LLVM_BIN/clang" \
    -DCMAKE_AR="$LLVM_BIN/llvm-ar" -DCMAKE_NM="$LLVM_BIN/llvm-nm" \
    -DCMAKE_RANLIB="$LLVM_BIN/llvm-ranlib" \
    -DCMAKE_C_COMPILER_TARGET="$triple" -DCMAKE_ASM_COMPILER_TARGET="$triple" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCOMPILER_RT_BAREMETAL_BUILD=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
    -DCOMPILER_RT_BUILD_BUILTINS=ON -DCOMPILER_RT_BUILD_SANITIZERS=OFF \
    -DCOMPILER_RT_BUILD_XRAY=OFF -DCOMPILER_RT_BUILD_LIBFUZZER=OFF \
    -DCOMPILER_RT_BUILD_PROFILE=OFF -DCOMPILER_RT_BUILD_MEMPROF=OFF \
    -DCOMPILER_RT_BUILD_ORC=OFF -DCOMPILER_RT_OS_DIR=baremetal \
    -DLLVM_CMAKE_DIR="$WORK/llvm/cmake/modules" \
    -DCMAKE_C_FLAGS="$cflags" -DCMAKE_ASM_FLAGS="$cflags"
  ninja -C "$WORK/rt-$key"
  install -D "$WORK/rt-$key"/lib/baremetal/libclang_rt.builtins-*.a \
    "$OUT/lib/$key/"  # keeps the arch-suffixed name clang -rtlib expects
}

build_picolibc() {  # <outkey> <clang --target> <cpu/arch flags...>
  local key="$1" target="$2"; shift 2; local flags="$*"
  local cross="$WORK/cross-$key.txt"
  cat > "$cross" <<EOF
[binaries]
c = ['$LLVM_BIN/clang', '--target=$target', $flags, '-nostdlib', '-fuse-ld=lld']
ar = '$LLVM_BIN/llvm-ar'
as = '$LLVM_BIN/clang'
nm = '$LLVM_BIN/llvm-nm'
strip = '$LLVM_BIN/llvm-strip'
[host_machine]
system = 'none'
cpu_family = 'arm'
cpu = 'arm'
endian = 'little'
[properties]
c_args = ['-Werror=double-promotion', '-Wno-unsupported-floating-point-opt', '-fshort-enums']
c_link_args = ['-Wl,-z,noexecstack']
skip_sanity_check = true
default_flash_addr = '0x10000000'
default_flash_size = '0x00400000'
default_ram_addr   = '0x20000000'
default_ram_size   = '0x00040000'
EOF
  PATH="$LLVM_BIN:$PATH" "$MESON" setup "$WORK/pl-$key" --cross-file "$cross" \
    -Dprefix="$OUT/lib/$key/picolibc" \
    -Dtests=false -Dmultilib=false -Dpicocrt=true \
    -Dsemihost=false -Dspecsdir=none -Dthread-local-storage=false \
    -Dnewlib-global-errno=true
  PATH="$LLVM_BIN:$PATH" "$MESON" install -C "$WORK/pl-$key"
}
# (meson cross-file c/cpp arrays want each flag quoted, hence the pre-quoted form)

# RP2040 — Cortex-M0+ / armv6-m, soft float
build_builtins pico armv6m-none-eabi -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft
build_picolibc pico thumbv6m-none-eabi "'-mcpu=cortex-m0plus', '-mfloat-abi=soft'"

# RP2350 — Cortex-M33 / armv8-m.main + dsp + fp, softfp ABI
build_builtins pico2 armv8m.main-none-eabi -mcpu=cortex-m33 -mthumb -mfloat-abi=softfp -march=armv8m.main+dsp+fp
build_picolibc pico2 armv8m.main-none-eabi "'-mcpu=cortex-m33', '-mfloat-abi=softfp', '-march=armv8m.main+dsp+fp'"

echo "=== permissive ARM libs built (compiler-rt builtins + picolibc) ==="
find "$OUT/lib" -name '*.a' -o -name 'crt0.o' | sort
