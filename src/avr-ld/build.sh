#!/bin/bash
set -xe -o pipefail

output_dir=${1:-/dist}

if [ ! -f "./configure" ]; then
    echo "Please run this script from the root of the binutils source tree"
    exit 1
fi
source_dir=$(pwd)
script_dir=$(dirname "$(realpath "$0")")

mkdir -p "$output_dir"
output_dir=$(realpath "$output_dir")

# Load device definitions (sets the DEVICES array)
# shellcheck source=devices.sh
source "$script_dir/devices.sh"

# Derive unique avr-libc architecture families and per-device CRT objects needed
declare -A arch_families
declare -A device_crts

for device in "${DEVICES[@]}"; do
    IFS=':' read -r _label _mcu arch crt <<< "$device"
    arch_families["$arch"]=1
    device_crts["$arch:$crt"]=1
done

sed -i '/^development=/s/true/false/' bfd/development.sh

# Note on the libiberty / libsframe / zlib sub-configure failure
# ----------------------------------------------------------------
# Earlier versions of this script passed all the emscripten-specific
# link flags (-sMODULARIZE=1, -sSINGLE_FILE=1, ...) as `LDFLAGS=` on
# the `emmake make` command line.  Make propagates that LDFLAGS into
# every sub-configure (libsframe, zlib, libiberty), where the very
# first thing AC_PROG_CC does is build a `conftest` to verify the C
# compiler can produce executables.  With the full emscripten LDFLAGS
# in place, that conftest link fails (-sSINGLE_FILE wrapping is not
# appropriate for a tiny conftest), which sets `gcc_no_link=yes`
# inside the configure shell.  After that, `GCC_NO_EXECUTABLES`
# (called at the top of libiberty/configure.ac) turns every subsequent
# `AC_LINK_IFELSE` into a fatal
#     configure: error: Link tests are not allowed after GCC_NO_EXECUTABLES.
#
# Two-phase fix: build everything first with plain LDFLAGS so the
# sub-configures succeed, then relink just `ld/ld-new` with the
# emscripten flags.
#
# Note on avr-libc embedding
# --------------------------
# A previous iteration tried to embed the required avr-libc archives
# and CRT objects directly into avr-ld.js with `emcc --embed-file`.
# That fails in Phase 2 because the binutils ld link rule goes through
# libtool, which silently strips driver flags it does not recognise
# (anything that is not -L, -l, -Wl, -o, -static, etc).  The bare
# `path@path` arguments then reach emcc with no `--embed-file` in
# front of them and emcc reports them as missing input files:
#     emcc: error: /usr/lib/avr/lib/avr6/libc.a@/...: No such file
# Instead we ship the avr-libc files as a sidecar `avr-libc/` tree
# under $output_dir.  At runtime the host (Node.js / WebView) loads
# these into Emscripten's MEMFS before invoking avr-ld; see
# docs/DESKTOP_AND_MAUI.md for the full pipeline.
#
# The only configure-time hint we keep is am_cv_ar_has_plugin to
# silence the (harmless) automake AM_PROG_AR --plugin probe noise.
_emsc_site=$(mktemp -t emscripten-site.XXXXXX)
printf 'am_cv_ar_has_plugin=no\n' > "$_emsc_site"
export CONFIG_SITE="$_emsc_site"

work_dir=$(mktemp -d -t "avr-ld.XXXXXX")
cd "$work_dir"

emconfigure "$source_dir/configure" \
    --target=avr \
    --host=wasm32 \
    --enable-ld=default \
    --enable-default-execstack=no \
    --disable-doc \
    --disable-gprof \
    --disable-nls \
    --disable-gas \
    --disable-gold \
    --disable-binutils \
    --disable-gdb \
    --disable-gdbserver \
    --disable-libdecnumber \
    --disable-readline \
    --disable-sim \
    --disable-werror

# Phase 1: build all libraries and ld with default LDFLAGS so that
# sub-configures (libsframe, zlib, libiberty, bfd) succeed.
emmake make -O -j"$(nproc)" \
    "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os"

# Phase 2: relink ld/ld-new with the emscripten link flags so the
# resulting JavaScript module is self-contained and exposes FS for
# the host to inject the avr-libc archives at runtime.
rm -f ld/ld-new
emmake make -O -j"$(nproc)" -C ld \
    "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os" \
    "LDFLAGS=-sMODULARIZE=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS -sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1" \
    ld-new

install -D "ld/ld-new" "$output_dir/avr-ld.js"

# Sidecar: copy the avr-libc files required by the supported devices
# into $output_dir/avr-libc/<arch>/ so consumers can mount them into
# Emscripten's FS at runtime.  We keep the upstream layout so the same
# `-L/usr/lib/avr/lib/<arch>` / crt path conventions used by the AVR
# toolchain documentation continue to work unchanged.
#
# Note: Debian's avr-libc ships only libc.a, libm.a and the per-MCU
# crt<full-mcu-name>.o startup objects under /usr/lib/avr/lib/<arch>/
# (e.g. crtatmega328p.o, not the legacy crtm328p.o short name).  There
# is no separate crtn.o (the device CRT object already includes the
# equivalent finalisation code), so we don't try to copy one.  We fail
# the build loudly if any required file is missing, otherwise the
# packaged tarball would silently be incomplete.
for arch in "${!arch_families[@]}"; do
    src_dir="/usr/lib/avr/lib/$arch"
    dst_dir="$output_dir/avr-libc/$arch"
    mkdir -p "$dst_dir"
    for f in libc.a libm.a; do
        if [ ! -f "$src_dir/$f" ]; then
            echo "error: required avr-libc file $src_dir/$f not found" >&2
            exit 1
        fi
        install -m 0644 "$src_dir/$f" "$dst_dir/$f"
    done
done

for key in "${!device_crts[@]}"; do
    arch="${key%%:*}"
    crt="${key##*:}"
    src_dir="/usr/lib/avr/lib/$arch"
    dst_dir="$output_dir/avr-libc/$arch"
    if [ ! -f "$src_dir/$crt" ]; then
        echo "error: required avr-libc CRT object $src_dir/$crt not found" >&2
        exit 1
    fi
    install -m 0644 "$src_dir/$crt" "$dst_dir/$crt"
done
