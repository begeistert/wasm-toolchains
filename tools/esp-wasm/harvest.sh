#!/bin/bash
# harvest.sh — runs INSIDE the espcap container for ONE esp board. Twin of
# pico-wasm/harvest.sh, generalized: the toolchain path is DISCOVERED (not
# hardcoded) from the gcc target triple, since esp32 (xtensa-esp-elf) and esp32c3
# (riscv32-esp-elf) live under different tool dirs and versions. Wraps cc1plus + ld
# to capture their expanded argv, compiles bigsketch.ino with arduino-cli, and
# emits to /out:
#   cc1plus-<tag>.txt / ld-<tag>.txt   every invocation (=== / --- @file delimited)
#   Big-<tag>-native.bin               the reference app image (objcopy .elf->.bin)
#   cacheb-<tag>.tar                   the per-board sketch cache (core.a + lib objs)
#
# Usage: harvest.sh <fqbn> <tag> <gccTarget>   e.g. harvest.sh esp32c3 esp32c3 riscv32-esp-elf
set -e
FQBN="$1"; TAG="$2"; GCCTARGET="$3"
[ -n "$FQBN" ] && [ -n "$TAG" ] && [ -n "$GCCTARGET" ] || { echo "usage: harvest.sh <fqbn> <tag> <gccTarget>"; exit 2; }
OUT=/out; mkdir -p "$OUT"; rm -f "$OUT/cc1plus-$TAG.txt" "$OUT/ld-$TAG.txt"

# Discover the toolchain: packages/esp32/tools/<...gcc...>/<ver>/ holding the
# cc1plus for $GCCTARGET. Glob both the unified (xtensa-esp-elf-gcc) and any
# triple-named layout; pick the first cc1plus that matches the target.
CC1=$(ls /root/.arduino15/packages/esp32/tools/*/*/libexec/gcc/${GCCTARGET}/*/cc1plus 2>/dev/null | head -1)
[ -n "$CC1" ] || { echo "[$TAG] cc1plus for $GCCTARGET not found under packages/esp32/tools"; exit 1; }
TCROOT=${CC1%/libexec/*}
LD=$(ls "$TCROOT/${GCCTARGET}/bin/ld" "$TCROOT/bin/${GCCTARGET}-ld" 2>/dev/null | head -1)
[ -n "$LD" ] || { echo "[$TAG] ld for $GCCTARGET not found"; exit 1; }

# Wrap a tool so each call dumps its expanded argv to a log, then exec the real one.
wrap() {
  local real="$1" log="$2"
  mv "$real" "$real.real"
  cat > "$real" <<EOF
#!/bin/bash
{ echo "=== $(basename "$real")"
  for a in "\$@"; do
    if [[ "\$a" == @* ]]; then echo "--- @file \${a:1}"; cat "\${a:1}"; else echo "\$a"; fi
  done
} >> "$log"
exec "$real.real" "\$@"
EOF
  chmod +x "$real"
}
wrap "$CC1" "$OUT/cc1plus-$TAG.txt"
wrap "$LD"  "$OUT/ld-$TAG.txt"

# Unique sketch name per board (arduino-cli derives its cache hash from the name).
SK="/s/Big_$TAG"
mkdir -p "$SK"
cp "$OUT/bigsketch.ino" "$SK/Big_$TAG.ino"

arduino-cli compile -b "esp32:esp32:$FQBN" --output-dir "$OUT/bo-$TAG" "$SK" \
  > "$OUT/clog-$TAG.log" 2>&1 || { echo "[$TAG] COMPILE FAILED"; tail -25 "$OUT/clog-$TAG.log"; exit 1; }

# The harvestable reference is the APP image (esptool also makes a .merged.bin with
# bootloader+partitions; the host places the app at flash[app] from the registry).
cp "$OUT/bo-$TAG/Big_$TAG.ino.bin" "$OUT/Big-$TAG-native.bin"
tar cf "$OUT/cacheb-$TAG.tar" /root/.cache/arduino/sketches 2>/dev/null || true
echo "[$TAG] native app bin: $(stat -c%s "$OUT/Big-$TAG-native.bin") bytes — OK"
