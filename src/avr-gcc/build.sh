#!/bin/bash
# Build the AVR C/C++ compilers proper (cc1, cc1plus) to WebAssembly and a
# matching target runtime sidecar, all from a single pristine GCC source so
# everything is ABI-consistent at one version.
#
# Why a desktop `avr-gcc` cannot just be ported
# ---------------------------------------------
# `avr-gcc` is a *driver*: it fork()/execve()s cc1plus, then as, then
# collect2/ld.  Emscripten has no fork/exec, so the driver can't run in a
# browser.  The compiler *proper* — cc1 (C) / cc1plus (C++) — is a single
# in-process program (one translation unit -> assembly) and ports cleanly.
# The JS orchestrator replaces the driver, chaining cc1plus -> avr-as ->
# avr-ld -> objcopy itself.
#
# Three sub-builds, in order:
#   NATIVE  : a real avr-gcc 15.2 (build=host=x86, target=avr).  Used only
#             to mine its libgcc.a + internal headers for the sidecar, to
#             record the exact cc1/cc1plus argv the driver generates (so the
#             JS orchestrator can reproduce it), and as a golden oracle.
#   DEPS    : GMP/MPFR/MPC cross-compiled to wasm32 (GCC needs them at
#             compile time for constant folding).
#   WASM    : cc1/cc1plus from the SAME source, Canadian-crossed to wasm32.
#             Because it is the same source as NATIVE, the wasm compiler's
#             output is ABI-compatible with the native libgcc.a we ship.
set -xe -o pipefail

output_dir=${1:-/dist}
mkdir -p "$output_dir"
output_dir=$(realpath "$output_dir")

GMP_VER=${GMP_VER:-6.3.0}
MPFR_VER=${MPFR_VER:-4.2.1}
MPC_VER=${MPC_VER:-1.3.1}

build_triple=$(/src/config.guess 2>/dev/null || echo x86_64-pc-linux-gnu)
nproc_n=$(nproc)

native_prefix=/opt/avr-native
wasmdeps=/opt/wasmdeps
mkdir -p "$native_prefix" "$wasmdeps"

# Boards we record cc1/cc1plus argv for (LABEL:MCU). Keep in sync with the
# avr-ld device list.
DEVICE_MCUS=("atmega328p" "atmega2560" "attiny85")

# ── NATIVE: real avr-gcc 15.2 (sidecar libgcc + argv capture + oracle) ───
# binutils-avr (apt) provides avr-as/avr-ld used while building libgcc.
# Idempotent: skip if a previous run already installed it (lets a persistent
# build container resume past this ~5min phase after a later-phase failure).
if [ ! -x "$native_prefix/bin/avr-gcc" ]; then
native_build=/opt/build/native; mkdir -p "$native_build"   # fixed dir → incremental re-runs
cd "$native_build"
/src/configure \
    --build="$build_triple" --host="$build_triple" --target=avr \
    --prefix="$native_prefix" \
    --enable-languages=c,c++ \
    --disable-bootstrap --disable-nls --disable-shared \
    --disable-libssp --disable-libada --disable-libquadmath \
    --disable-libgomp --disable-libvtv --disable-libstdcxx \
    --with-dwarf2 \
    MAKEINFO=missing
# Compiler proper + target libgcc (skip libstdc++ for speed; the Arduino
# core supplies its own operator new/delete).
make -j"$nproc_n" all-gcc all-target-libgcc
make install-gcc install-target-libgcc
fi
export PATH="$native_prefix/bin:$PATH"

# Record the exact cc1/cc1plus argv the 15.2 driver emits per MCU.  The JS
# orchestrator reads these to reproduce the implicit flags (-mmcu=avr5,
# -D__AVR_*__, -isystem ..., device specs) that the driver normally adds.
mkdir -p "$output_dir/specs"
printf 'int main(void){return 0;}\n' > /tmp/probe.c
printf 'int main(void){return 0;}\n' > /tmp/probe.cpp
for mcu in "${DEVICE_MCUS[@]}"; do
    avr-gcc -Os -mmcu="$mcu" -ffunction-sections -fdata-sections \
        -v -S /tmp/probe.c -o /dev/null 2>"$output_dir/specs/cc1-$mcu.txt" || true
    avr-g++ -Os -mmcu="$mcu" -ffunction-sections -fdata-sections \
        -fno-exceptions -fno-threadsafe-statics \
        -v -S /tmp/probe.cpp -o /dev/null 2>"$output_dir/specs/cc1plus-$mcu.txt" || true
    # Also record the collect2/ld link line so the orchestrator can mirror the
    # device-specific -Tdata <addr> and -l<mcu> the driver injects.
    avr-as -mmcu="$mcu" -o /tmp/probe.o /tmp/probe.s 2>/dev/null || \
        printf '.text\n.global main\nmain: ret\n' > /tmp/probe.s
    avr-as -mmcu="$mcu" -o /tmp/probe.o /tmp/probe.s 2>/dev/null || true
    avr-gcc -mmcu="$mcu" -v -o /tmp/probe.elf /tmp/probe.o \
        2>"$output_dir/specs/link-$mcu.txt" || true
done

# ── DEPS: GMP / MPFR / MPC → wasm32 (static) ────────────────────────────
# These are cross builds (host=wasm32) but their configure/build still needs
# a working *native* build compiler for the small generator programs GMP/MPC
# compile and run at build time.  emconfigure points CC at emcc, so we must
# pin CC_FOR_BUILD/HOST_CC at the native gcc explicitly, otherwise configure
# picks emsdk's clang as the build compiler and aborts ("HOST_CC doesn't
# seem to work").
export CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ HOST_CC=gcc HOST_CXX=g++
export BUILD_CC=gcc

if [ ! -f "$wasmdeps/lib/libmpc.a" ]; then
cd /deps/gmp-${GMP_VER}
emconfigure ./configure --build="$build_triple" --host=wasm32 \
    --prefix="$wasmdeps" --disable-shared --enable-static --disable-assembly \
    CC_FOR_BUILD=gcc
emmake make -j"$nproc_n"; emmake make install

cd /deps/mpfr-${MPFR_VER}
emconfigure ./configure --build="$build_triple" --host=wasm32 \
    --prefix="$wasmdeps" --disable-shared --enable-static \
    --with-gmp="$wasmdeps" CC_FOR_BUILD=gcc
emmake make -j"$nproc_n"; emmake make install

cd /deps/mpc-${MPC_VER}
emconfigure ./configure --build="$build_triple" --host=wasm32 \
    --prefix="$wasmdeps" --disable-shared --enable-static \
    --with-gmp="$wasmdeps" --with-mpfr="$wasmdeps" CC_FOR_BUILD=gcc
emmake make -j"$nproc_n"; emmake make install
fi

# ── WASM: cc1 / cc1plus, Canadian cross to AVR ──────────────────────────
# CC_FOR_BUILD stays native (compiles the gen* programs that run during the
# build); emconfigure points CC at emcc for the host (wasm) parts.
#
# Pre-seed am_cv_ar_has_plugin=no via CONFIG_SITE: otherwise libiberty's
# configure probes whether `ar` accepts --plugin, emar says yes, and the
# build then calls `emar --plugin liblto_plugin.so` which doesn't exist
# (we --disable-lto), failing with "liblto_plugin.so: No such file".
_emsc_site=$(mktemp -t emscripten-site.XXXXXX)
printf 'am_cv_ar_has_plugin=no\nam_cv_ranlib_has_plugin=no\n' > "$_emsc_site"
export CONFIG_SITE="$_emsc_site"

wasm_build=/opt/build/wasm; mkdir -p "$wasm_build"   # fixed dir → incremental re-runs
cd "$wasm_build"
if [ ! -f "$wasm_build/Makefile" ]; then
emconfigure /src/configure \
    --build="$build_triple" --host=wasm32 --target=avr \
    --prefix=/opt/avr-wasm \
    --enable-languages=c,c++ \
    --with-gmp="$wasmdeps" --with-mpfr="$wasmdeps" --with-mpc="$wasmdeps" \
    --disable-bootstrap --disable-shared --disable-threads --disable-nls \
    --disable-libssp --disable-libada --disable-libquadmath \
    --disable-libgomp --disable-libvtv --enable-lto --disable-libstdcxx \
    --without-headers --disable-werror \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ MAKEINFO=missing
fi

# Phase A: build compilers proper with plain LDFLAGS so the host sub-libs
# (libiberty, libcpp, libdecnumber, libbacktrace) link during the build.
# -DHAVE_PSIGNAL=1: libiberty otherwise ships its own psignal(char*) which
# conflicts with emscripten's musl psignal(const char*); the binutils builds
# in this repo use the same flag. -DELIDE_CODE drops more such shims.
HOSTCFLAGS="-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os"
# all-gcc also links auxiliary tools (gcov-tool needs ftw(), which emscripten
# musl lacks -> wasm-ld undefined symbol). We don't ship those tools; tolerate
# their failure here. This pass exists only to build the prerequisites
# (generators, libbackend.a, host libs); Phase B links the cc1/cc1plus we keep.
emmake make -O -j"$nproc_n" all-gcc "CFLAGS=$HOSTCFLAGS" "CXXFLAGS=$HOSTCFLAGS" || \
  echo "all-gcc returned nonzero (expected: auxiliary tools like gcov-tool); continuing to Phase B"

# Phase B: relink cc1/cc1plus/lto1 with the emscripten flags so each becomes a
# self-contained module exposing FS + callMain for the host orchestrator.
# lto1 is the LTO compiler the orchestrator runs at link time for -flto builds.
# We deliberately DON'T use -sSINGLE_FILE here: a separate .wasm (vs base64
# inlined in the .js, +33%) is smaller and compresses far better with brotli,
# which matters for the iOS bundle. emscripten's loader fetches the sibling
# <tool>.wasm by name, so renaming the .js to <tool>.js still resolves it.
EMFLAGS="-sMODULARIZE=1 -sEXPORT_NAME=createModule \
    -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    -sALLOW_MEMORY_GROWTH=1 -sUSE_ZLIB=1 \
    -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=8MB"
rm -f gcc/cc1 gcc/cc1plus gcc/lto1
emmake make -O -j"$nproc_n" -C gcc cc1 cc1plus lto1 \
    "CFLAGS=$HOSTCFLAGS" "CXXFLAGS=$HOSTCFLAGS" "LDFLAGS=$EMFLAGS"

# emscripten emits <name> (js) + <name>.wasm; install both, renaming js -> .js.
for t in cc1 cc1plus lto1; do
    install -D "gcc/$t"      "$output_dir/$t.js"
    install -D "gcc/$t.wasm" "$output_dir/$t.wasm"
done

# ── Sidecar: target runtime the wasm avr-ld consumes at link time ───────
# Everything below is AVR *target* binary/text — never compiled to wasm; the
# wasm avr-ld/avr-as read it from MEMFS exactly like the desktop toolchain
# reads it from disk. Layout:
#   sysroot/avr/include/         avr-libc C headers
#   sysroot/avr/lib/<arch>/      libc.a libm.a crt<mcu>.o lib<mcu>.a
#   sysroot/avr/lib/ldscripts/   linker scripts (avr5.x, ...)
#   sysroot/gcc-include/         gcc internal + fixed headers (stddef.h, ...)
#   sysroot/libgcc/<arch>/libgcc.a   from the NATIVE 15.2 build (ABI-matches
#                                    the wasm cc1plus, which is the same src)
sidecar="$output_dir/sysroot"
# Start clean: $output_dir persists across re-runs in the build container, and
# `cp -a src dst` nests (dst/include/include) when dst already exists.
rm -rf "$sidecar"
mkdir -p "$sidecar/avr" "$sidecar/gcc-include" "$sidecar/libgcc"

# avr-libc: headers + the whole lib tree (per-arch archives, crt, device
# libs, and ldscripts). Copying the tree wholesale keeps the conventional
# /usr/lib/avr/... path conventions intact.
cp -a /usr/lib/avr/include "$sidecar/avr/include"
cp -a /usr/lib/avr/lib     "$sidecar/avr/lib"

native_libdir="$native_prefix/lib/gcc/avr/15.2.0"
cp -a "$native_libdir/." "$sidecar/libgcc/"                   # libgcc.a (multilib) + include-fixed
cp -a "$native_libdir/include/." "$sidecar/gcc-include/" 2>/dev/null || true
cp -a "$native_libdir/include-fixed/." "$sidecar/gcc-include/" 2>/dev/null || true

echo "=== sidecar tree ===" ; find "$sidecar" -maxdepth 3 -type d | head -60
echo "=== libgcc per arch ===" ; find "$sidecar/libgcc" -name libgcc.a
echo "=== recorded specs ===" ; ls -la "$output_dir/specs"
