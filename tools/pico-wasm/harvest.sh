#!/bin/bash
# harvest.sh — runs INSIDE the picocap container for ONE board. Wraps cc1plus + ld
# so we capture their exact (response-file-expanded) argv, compiles bigsketch.ino
# with arduino-cli, and emits to /out:
#   cc1plus-<tag>.txt   every cc1plus invocation (=== / --- @file delimited)
#   ld-<tag>.txt        every ld invocation
#   Big-<tag>-native.uf2  the reference firmware (for byte/flash verification)
#   cacheb-<tag>.tar    the per-board sketch cache (compiled core.a + lib objects)
# The 3rd-party library *sources* live in /root/Arduino/libraries (board-agnostic);
# harvest-libs.sh tars those once.
#
# Usage: harvest.sh <fqbn> <tag>   e.g. harvest.sh rpipico pico
set -e
FQBN="$1"; TAG="$2"
[ -n "$FQBN" ] && [ -n "$TAG" ] || { echo "usage: harvest.sh <fqbn> <tag>"; exit 2; }
OUT=/out; mkdir -p "$OUT"; rm -f "$OUT/cc1plus-$TAG.txt" "$OUT/ld-$TAG.txt"

TC=$(echo /root/.arduino15/packages/rp2040/tools/pqt-gcc/*)
CC1="$TC/libexec/gcc/arm-none-eabi/14.3.0/cc1plus"
LD="$TC/arm-none-eabi/bin/ld"

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

# Unique sketch name per board — arduino-cli derives its build-cache hash from the
# sketch name (NOT the FQBN), so a shared name would collide across boards.
SK="/s/Big_$TAG"
mkdir -p "$SK"
cp "$OUT/bigsketch.ino" "$SK/Big_$TAG.ino"

arduino-cli compile -b "rp2040:rp2040:$FQBN" --output-dir "$OUT/bo-$TAG" "$SK" \
  > "$OUT/clog-$TAG.log" 2>&1 || { echo "[$TAG] COMPILE FAILED"; tail -25 "$OUT/clog-$TAG.log"; exit 1; }

cp "$OUT/bo-$TAG/Big_$TAG.ino.uf2" "$OUT/Big-$TAG-native.uf2"
tar cf "$OUT/cacheb-$TAG.tar" /root/.cache/arduino/sketches 2>/dev/null || true
echo "[$TAG] native UF2: $(stat -c%s "$OUT/Big-$TAG-native.uf2") bytes — OK"
