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
nproc_n=${NPROC:-$(nproc)}   # cap to bound RAM (clang -j on all cores can OOM)

SRC=/src/llvm                                   # the llvm subproject of the monorepo
TARGETS=${LLVM_TARGETS:-"ARM;AArch64;RISCV;AVR"}
EXPERIMENTAL=${LLVM_EXPERIMENTAL_TARGETS:-"Xtensa"}
TOOLS="llc opt lld llvm-mc llvm-objcopy"

# WITH_CLANG=1 also builds the clang C/C++ frontend (clang.wasm) — the permissive
# (Apache-2.0) replacement for the GPL cc1plus. It's opt-in because clang is a huge
# extra build (needs a native clang-tblgen too) and the IR-backend bundle doesn't
# need it. One clang.wasm is multi-target (frontend is target-agnostic; -target /
# -mcpu selects the backend among TARGETS).
PROJECTS="lld"
if [ "${WITH_CLANG:-}" = "1" ]; then PROJECTS="lld;clang"; TOOLS="$TOOLS clang"; fi

EMFLAGS="-sMODULARIZE=1 -sEXPORT_NAME=createModule \
    -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sEXIT_RUNTIME=1 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB"

# ── 1. NATIVE tablegen (host tools the cross build invokes) ─────────────────
NATIVE_TBLGEN="llvm-tblgen llvm-min-tblgen"
[ "${WITH_CLANG:-}" = "1" ] && NATIVE_TBLGEN="$NATIVE_TBLGEN clang-tblgen"
if [ ! -x /opt/native/bin/llvm-tblgen ] || { [ "${WITH_CLANG:-}" = "1" ] && [ ! -x /opt/native/bin/clang-tblgen ]; }; then
  cmake -G Ninja -S "$SRC" -B /opt/native \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="$PROJECTS" \
    -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
    -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="$EXPERIMENTAL" \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF
  ninja -C /opt/native -j"$nproc_n" $NATIVE_TBLGEN
fi

# ── 2. EMSCRIPTEN cross build (host = wasm32) ───────────────────────────────
# MinSizeRel: wasm size is the shipping cost. Threads/zlib/zstd/libxml off — no
# pthreads in this build and the optional deps only bloat the module.
emcmake cmake -G Ninja -S "$SRC" -B /opt/wasm \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_ENABLE_PROJECTS="$PROJECTS" \
    -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
    -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD="$EXPERIMENTAL" \
    -DLLVM_TABLEGEN=/opt/native/bin/llvm-tblgen \
    -DCLANG_TABLEGEN=/opt/native/bin/clang-tblgen \
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
# host selects the ELF driver with `-flavor gnu` (no argv[0]=ld.lld needed). clang
# may build as bin/clang or bin/clang-<major>; install under the canonical name.
for t in $TOOLS; do
  src="/opt/wasm/bin/$t"
  [ -f "$src.js" ] || src=$(ls /opt/wasm/bin/$t*.js 2>/dev/null | head -1 | sed 's/\.js$//')
  install -D "$src.js"   "$output_dir/$t.js"
  install -D "$src.wasm" "$output_dir/$t.wasm"
done

echo "=== llvm IR backend WASM built (targets: $TARGETS + $EXPERIMENTAL) ==="
ls -lh "$output_dir"/*.js
