#!/bin/bash
# Build the LLVM IR backend tools to WebAssembly (Emscripten), as a single
# multi-target backend: llc / opt / lld / llvm-mc / llvm-objcopy. The input IR (or
# an explicit -mtriple) picks the target, so ONE llc.wasm covers every arch in
# LLVM_TARGETS — no per-arch wasm the way the GCC tracks need a cc1plus each.
#
# Cross-compiling LLVM needs the table-generated headers built by a NATIVE
# llvm-tblgen first (tblgen runs on the build host, not in wasm), then a second
# Emscripten configure that points LLVM_TABLEGEN/LLVM_NATIVE_TOOL_DIR at it. The
# tools link with the same Emscripten flags as the gcc tracks (MODULARIZE +
# createModule + a FORCE_FILESYSTEM data interface), so each ships as a .js loader
# + .wasm sidecar the host drives through argv + a virtual filesystem.
set -xe -o pipefail

output_dir=${1:-/dist}
mkdir -p "$output_dir"; output_dir=$(realpath "$output_dir")
nproc_n=$(nproc)

SRC=/src/llvm                                   # the llvm subproject of the monorepo
TARGETS=${LLVM_TARGETS:-"ARM;AArch64;RISCV;AVR"}
EXPERIMENTAL=${LLVM_EXPERIMENTAL_TARGETS:-"Xtensa"}
TOOLS="llc opt lld llvm-mc llvm-objcopy"

EMFLAGS="-sMODULARIZE=1 -sEXPORT_NAME=createModule \
    -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sEXIT_RUNTIME=1 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB"

# ── 1. NATIVE tablegen (host tools the cross build invokes) ─────────────────
if [ ! -x /opt/native/bin/llvm-tblgen ]; then
  cmake -G Ninja -S "$SRC" -B /opt/native \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="lld" \
    -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
    -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="$EXPERIMENTAL" \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF
  ninja -C /opt/native -j"$nproc_n" llvm-tblgen llvm-min-tblgen
fi

# ── 2. EMSCRIPTEN cross build (host = wasm32) ───────────────────────────────
# MinSizeRel: wasm size is the shipping cost. Threads/zlib/zstd/libxml off — no
# pthreads in this build and the optional deps only bloat the module.
emcmake cmake -G Ninja -S "$SRC" -B /opt/wasm \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_ENABLE_PROJECTS="lld" \
    -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
    -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="$EXPERIMENTAL" \
    -DLLVM_TABLEGEN=/opt/native/bin/llvm-tblgen \
    -DLLVM_NATIVE_TOOL_DIR=/opt/native/bin \
    -DCMAKE_CROSSCOMPILING=ON \
    -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
    -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-emscripten \
    -DLLVM_TARGET_ARCH=wasm32 \
    -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
    -DLLVM_ENABLE_PIC=OFF -DLLVM_BUILD_TOOLS=ON \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="$EMFLAGS"

for t in $TOOLS; do
  ninja -C /opt/wasm -j"$nproc_n" "$t"
done

# Emscripten emits bin/<tool>.js + bin/<tool>.wasm. lld is the multiplexer; the
# host selects the ELF driver with `-flavor gnu` (no argv[0]=ld.lld needed).
for t in $TOOLS; do
  install -D "/opt/wasm/bin/$t.js"   "$output_dir/$t.js"
  install -D "/opt/wasm/bin/$t.wasm" "$output_dir/$t.wasm"
done

echo "=== llvm IR backend WASM built (targets: $TARGETS + $EXPERIMENTAL) ==="
ls -lh "$output_dir"/*.js
