#!/bin/bash
# Build the Espressif GCC cross-compiler proper (cc1, cc1plus, lto1) AND binutils
# (as, ld, objcopy, ar) to WebAssembly for on-device ESP32 compiling. Parametrized
# by $TARGET (riscv32-esp-elf | xtensa-esp-elf); for Xtensa, $XTENSA_OVERLAY names
# the chip config applied from the xtensa-overlays repo. Same Canadian-cross
# approach as src/arm-gcc — host=wasm32, deps GMP/MPFR/MPC → wasm32 — sourced from
# the Espressif forks for ABI parity with arduino-esp32's precompiled core.
set -xe -o pipefail

output_dir=${1:-/dist}
mkdir -p "$output_dir"; output_dir=$(realpath "$output_dir")

GMP_VER=${GMP_VER:-6.3.0}; MPFR_VER=${MPFR_VER:-4.2.1}; MPC_VER=${MPC_VER:-1.3.1}
TARGET=${TARGET:-riscv32-esp-elf}
XTENSA_OVERLAY=${XTENSA_OVERLAY:-}
build_triple=$(/src/config.guess 2>/dev/null || echo x86_64-pc-linux-gnu)
nproc_n=$(nproc)
wasmdeps=/opt/wasmdeps; mkdir -p "$wasmdeps"

EMFLAGS="-sMODULARIZE=1 -sEXPORT_NAME=createModule \
    -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=8MB"
_site=$(mktemp -t emscripten-site.XXXXXX)
printf 'am_cv_ar_has_plugin=no\nam_cv_ranlib_has_plugin=no\n' > "$_site"; export CONFIG_SITE="$_site"
export CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ HOST_CC=gcc HOST_CXX=g++

# ── XTENSA: apply the chip overlay (gives binutils/gcc the esp32 config) ─────
# Apply the chip overlay STATICALLY into the gcc + binutils source trees, the way
# crosstool-NG does. Upstream gcc has no esp32 config; the overlay's xtensa-config.h
# (etc.) provides it. We deliberately do NOT export XTENSA_GNU_CONFIG: that selects
# Espressif's *dynamic* config, which dlopen()s a plugin at runtime — impossible in
# a static wasm build (cc1plus then aborts: "XTENSA_GNU_CONFIG is defined but plugin
# support is disabled"). With the overlay baked in and the env var unset, gcc
# compiles the esp32 config statically and needs no plugin.
#
# Overlay layout: /src-overlays/xtensa_<chip>/{gcc,binutils}/ mirror each source
# root (e.g. xtensa_esp32/gcc/gcc/config/xtensa/xtensa-config.h → /src/gcc/...).
if [ -n "$XTENSA_OVERLAY" ]; then
  ovd=/src-overlays/xtensa_${XTENSA_OVERLAY}
  unset XTENSA_GNU_CONFIG
  applied=0
  [ -d "$ovd/gcc" ]      && { cp -rf "$ovd/gcc/."      /src/;          applied=1; }
  [ -d "$ovd/binutils" ] && { cp -rf "$ovd/binutils/." /src-binutils/; applied=1; }
  [ "$applied" = 1 ] || echo "WARN: xtensa overlay $XTENSA_OVERLAY not found under $ovd — build may target generic xtensa"
fi

# ── gcc 13.2 source fixups for the em++/clang wasm cross build ──────────────
# The per-target selftest sources (config/<arch>/*-selftests.cc) are linked into
# cc1 unconditionally by the t-<arch> makefile fragment, but their includes don't
# compile under em++/clang. With --enable-checking=release the selftests are never
# run and the code that references them is compiled out, so blank the sources.
for f in $(find /src/gcc/config -name '*-selftests.cc' 2>/dev/null); do
  echo "/* selftests stubbed for the static wasm cross build (checking=release) */" > "$f"
done

# ── DEPS: GMP / MPFR / MPC → wasm32 ─────────────────────────────────────────
if [ ! -f "$wasmdeps/lib/libmpc.a" ]; then
  cd /deps/gmp-${GMP_VER};   emconfigure ./configure --build="$build_triple" --host=wasm32 --prefix="$wasmdeps" --disable-shared --enable-static --disable-assembly CC_FOR_BUILD=gcc; emmake make -j"$nproc_n"; emmake make install
  cd /deps/mpfr-${MPFR_VER}; emconfigure ./configure --build="$build_triple" --host=wasm32 --prefix="$wasmdeps" --disable-shared --enable-static --with-gmp="$wasmdeps" CC_FOR_BUILD=gcc; emmake make -j"$nproc_n"; emmake make install
  cd /deps/mpc-${MPC_VER};   emconfigure ./configure --build="$build_triple" --host=wasm32 --prefix="$wasmdeps" --disable-shared --enable-static --with-gmp="$wasmdeps" --with-mpfr="$wasmdeps" CC_FOR_BUILD=gcc; emmake make -j"$nproc_n"; emmake make install
fi

# ── BINUTILS ($TARGET) → WASM: as / ld / objcopy / ar ───────────────────────
bu=/opt/build/binutils; mkdir -p "$bu"; cd "$bu"
if [ ! -f "$bu/Makefile" ]; then
  sed -i '/^development=/s/true/false/' /src-binutils/bfd/development.sh || true
  emconfigure /src-binutils/configure --target=$TARGET --host=wasm32 --build="$build_triple" \
    --enable-ld=default --disable-gold --disable-gdb --disable-gdbserver --disable-sim \
    --disable-nls --disable-werror --disable-doc --disable-gprof \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ MAKEINFO=missing
fi
emmake make -O -j"$nproc_n" all-bfd all-libiberty all-opcodes all-libsframe \
    "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os"
emmake make -O -j"$nproc_n" all-gas all-ld all-binutils \
    "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os" || true
as_name=$(echo "$TARGET" | sed 's/-esp-elf//')   # riscv32-as / xtensa-as
for pair in "gas/as-new:${as_name}-as" "ld/ld-new:${as_name}-ld" "binutils/objcopy:objcopy" "binutils/ar:ar"; do
  src=${pair%%:*}; name=${pair##*:}
  rm -f "$bu/$src"
  emmake make -O -j"$nproc_n" -C "$bu/$(dirname "$src")" "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os" "LDFLAGS=$EMFLAGS" "$(basename "$src")"
  install -D "$bu/$src" "$output_dir/$name.js"
  [ -f "$bu/$src.wasm" ] && install -D "$bu/$src.wasm" "$output_dir/$name.wasm" || true
done

# ── GCC ($TARGET) cc1/cc1plus/lto1 → WASM (Canadian cross) ───────────────────
gw=/opt/build/gcc; mkdir -p "$gw"; cd "$gw"
if [ ! -f "$gw/Makefile" ]; then
  emconfigure /src/configure --build="$build_triple" --host=wasm32 --target=$TARGET \
    --prefix=/opt/esp-wasm --enable-languages=c,c++ \
    --with-gmp="$wasmdeps" --with-mpfr="$wasmdeps" --with-mpc="$wasmdeps" \
    --disable-bootstrap --disable-shared --disable-threads --disable-nls \
    --disable-libssp --disable-libada --disable-libquadmath --disable-libgomp \
    --disable-libvtv --enable-lto --disable-libstdcxx --without-headers --disable-werror \
    --enable-checking=release \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ MAKEINFO=missing
fi
HOSTCFLAGS="-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os"
emmake make -O -j"$nproc_n" all-gcc "CFLAGS=$HOSTCFLAGS" "CXXFLAGS=$HOSTCFLAGS" || \
  echo "all-gcc nonzero (expected: gcov-tool ftw); continuing"
rm -f gcc/cc1 gcc/cc1plus gcc/lto1
emmake make -O -j"$nproc_n" -C gcc cc1 cc1plus lto1 "CFLAGS=$HOSTCFLAGS" "CXXFLAGS=$HOSTCFLAGS" "LDFLAGS=$EMFLAGS"
for t in cc1 cc1plus lto1; do
  install -D "gcc/$t" "$output_dir/$t.js"
  install -D "gcc/$t.wasm" "$output_dir/$t.wasm"
done

echo "=== esp toolchain WASM built (target: $TARGET${XTENSA_OVERLAY:+, overlay $XTENSA_OVERLAY}) ==="
ls -lh "$output_dir"/*.js
