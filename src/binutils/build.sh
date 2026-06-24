#!/bin/bash
set -xe -o pipefail

output_dir=${1:-/dist}

if [ ! -f "./configure" ]; then
    echo "Please run this script from the root of the binutils source tree"
    exit 1
fi
source_dir=$(pwd)

mkdir -p "$output_dir"
output_dir=$(realpath "$output_dir")

target_paths=(
    "binutils/addr2line"
    "binutils/ar"
    "binutils/cxxfilt"
    "binutils/elfedit"
    "binutils/nm-new"
    "binutils/objcopy"
    "binutils/objdump"
    "binutils/ranlib"
    "binutils/readelf"
    "binutils/size"
    "binutils/strings"
    "binutils/strip-new"
)

sed -i '/^development=/s/true/false/' bfd/development.sh

work_dir=$(mktemp -d -t "binutils.XXXXXX")
cd "$work_dir"

emconfigure "$source_dir/configure" \
    --enable-default-execstack=no \
    --enable-deterministic-archives \
    --enable-ld=default \
    --enable-new-dtags \
    --disable-doc \
    --disable-gprof \
    --disable-nls \
    --disable-gas \
    --disable-ld \
    --disable-gdb \
    --disable-gdbserver \
    --disable-libdecnumber \
    --disable-readline \
    --disable-sim \
    --disable-werror \
    --host=wasm32 \
    --enable-64-bit-bfd \
    --enable-targets=all

emmake make -O -j"$(nproc)" \
    "CFLAGS=-DHAVE_PSIGNAL=1 -DELIDE_CODE -Os" \
    "LDFLAGS=-sMODULARIZE=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS -sSINGLE_FILE=1"

for path in "${target_paths[@]}"; do
    exe_name=$(basename "$path" | sed 's/-new$//')
    install -D "$path" "$output_dir/$exe_name.js"
done
