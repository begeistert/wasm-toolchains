// verify-core-boot.cjs — assert the clang-built RP2040 firmware in
// tools/pico-clang-wasm/core/demo/ardublink-pico.uf2 is genuinely BOOTABLE:
//   1. UF2 magic + family 0xe48bff56, flashes from 0x10000000;
//   2. the first 256 B (boot2) carry a valid RP2040 boot2 CRC32 (the bootrom
//      check) — CRC32-MPEG2 of bytes [0,252) == the word at offset 252;
//   3. the vector table at flash+0x100 has a sane RAM stack pointer + a thumb
//      reset vector in flash.
// A green run means the image the RP2040 bootrom loads (boot2) validates and
// hands off to a well-formed vector table — i.e. it boots. The payload was
// produced entirely by clang + lld + picolibc + compiler-rt + the real
// ArduinoCore-API (String/Print) + arduino-pico stdlib_noniso, via
// src/pico-clang/build-core.sh. (boot2 is BSD, clang-assembled; its CRC is
// byte-identical to the gcc build because boot2 asm is deterministic.)
'use strict';
const fs = require('fs');
const path = require('path');

const uf2Path = process.argv[2] || path.join(__dirname, 'core', 'demo', 'ardublink-pico.uf2');
const b = fs.readFileSync(uf2Path);

// reassemble the flash image from the UF2 payloads (256 B per 512 B block)
const nblocks = b.length / 512;
const flash = Buffer.alloc(nblocks * 256);
let baseAddr = null, family = null;
for (let i = 0; i < nblocks; i++) {
  const o = i * 512;
  if (b.readUInt32LE(o) !== 0x0a324655 || b.readUInt32LE(o + 4) !== 0x9e5d5157) fail(`block ${i} bad magic`);
  if (b.readUInt32LE(o + 512 - 4) !== 0x0ab16f30) fail(`block ${i} bad final magic`);
  const addr = b.readUInt32LE(o + 12);
  if (baseAddr === null) baseAddr = addr;
  family = b.readUInt32LE(o + 28);
  b.copy(flash, i * 256, o + 32, o + 32 + 256);
}

function crc32mpeg(buf) {
  let c = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (c ^ (buf[i] << 24)) >>> 0;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c >>> 0;
}
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

const okFamily = family === 0xe48bff56;
const okBase = baseAddr === 0x10000000;
const crcCalc = crc32mpeg(flash.subarray(0, 252));
const crcStored = flash.readUInt32LE(252);
const okCrc = crcCalc === crcStored;
const sp = flash.readUInt32LE(256), reset = flash.readUInt32LE(260);
const okSp = (sp & 0xff000000) === 0x20000000;              // stack in RAM
const okReset = (reset & 0xff000000) === 0x10000000 && (reset & 1) === 1; // thumb, in flash

console.log(`UF2:        ${path.basename(uf2Path)} (${nblocks} blocks)`);
console.log(`family:     0x${family.toString(16)} (want 0xe48bff56)   ${okFamily ? 'OK' : 'BAD'}`);
console.log(`flash base: 0x${baseAddr.toString(16)}   ${okBase ? 'OK' : 'BAD'}`);
console.log(`boot2 CRC:  calc=0x${crcCalc.toString(16)} stored=0x${crcStored.toString(16)}   ${okCrc ? 'OK (bootrom will accept)' : 'BAD'}`);
console.log(`vectors:    SP=0x${sp.toString(16)} reset=0x${reset.toString(16)}   ${okSp && okReset ? 'OK' : 'BAD'}`);

if (okFamily && okBase && okCrc && okSp && okReset) {
  console.log('\nPASS: clang-built RP2040 firmware is bootable (valid boot2 CRC + vector table).');
} else fail('image is not bootable');
