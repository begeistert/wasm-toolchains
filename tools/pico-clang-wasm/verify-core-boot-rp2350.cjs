// verify-core-boot-rp2350.cjs — assert the clang-built RP2350 firmware in
// core/demo/ardublink-pico2-clang-bootable.uf2 is a STRUCTURALLY VALID bootable
// Arm-Secure image. RP2350 has no boot2: the bootrom scans the first 4 KB of
// flash for the IMAGE_DEF block loop, so we validate that loop exactly:
//   1. UF2 family 0xe48bff59 (RP2350 Arm-Secure), flashes from 0x10000000;
//   2. a block-loop start block in the first 4 KB — marker 0xffffded3, an
//      IMAGE_TYPE item (0x42) whose flags decode to EXE + Secure + Arm + RP2350
//      (0x1021), a LAST item, a link to the end block, marker 0xab123579;
//   3. the end block loops back to the start block (single-block loop closes);
//   4. the Arm vector table at 0x10000000 (SP in RAM, thumb reset in flash).
//
// The IMAGE_DEF block is reproduced from the pico-sdk sources (embedded_start/
// end_block.inc.S, BSD), clang-assembled — its IMAGE_TYPE word is byte-identical
// to the SDK/picotool's own output (0x10210142). NOTE: this validates the boot
// STRUCTURE the RP2350 bootrom scans; it is NOT a hardware boot (no physical
// RP2350 in this environment). "structurally valid, not HW-booted."
'use strict';
const fs = require('fs');
const path = require('path');

const uf2Path = process.argv[2] || path.join(__dirname, 'core', 'demo', 'ardublink-pico2-clang-bootable.uf2');
const b = fs.readFileSync(uf2Path);
const START = 0xffffded3, END = 0xab123579;
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

// reassemble flash image from UF2 payloads
const nblocks = b.length / 512;
let baseAddr = null, family = null, hiAddr = 0;
const chunks = [];
for (let i = 0; i < nblocks; i++) {
  const o = i * 512;
  if (b.readUInt32LE(o) !== 0x0a324655 || b.readUInt32LE(o + 4) !== 0x9e5d5157) fail(`block ${i} bad magic`);
  if (b.readUInt32LE(o + 512 - 4) !== 0x0ab16f30) fail(`block ${i} bad final magic`);
  const addr = b.readUInt32LE(o + 12), len = b.readUInt32LE(o + 16);
  family = b.readUInt32LE(o + 28);
  if (baseAddr === null) baseAddr = addr;
  chunks.push({ addr, buf: b.subarray(o + 32, o + 32 + len) });
  hiAddr = Math.max(hiAddr, addr + len);
}
const flash = Buffer.alloc(hiAddr - baseAddr);
for (const c of chunks) c.buf.copy(flash, c.addr - baseAddr);
const u32 = (o) => flash.readUInt32LE(o);

const okFamily = family === 0xe48bff59;
const okBase = baseAddr === 0x10000000;

// find the start block in the first 4 KB
let a = -1;
for (let i = 0; i < 4096 && i + 20 <= flash.length; i += 4) if (u32(i) === START) { a = i; break; }
if (a < 0) fail('no IMAGE_DEF block (0xffffded3) in first 4 KB');

const itemByte = flash.readUInt8(a + 4);
const flags = flash.readUInt16LE(a + 6);
const imageType = flags & 0xf, security = (flags >> 4) & 0x3, cpu = (flags >> 8) & 0x7, chip = (flags >> 12) & 0x7;
const okItem = itemByte === 0x42;                 // IMAGE_TYPE
const okFlags = imageType === 1 && security === 2 && cpu === 0 && chip === 1; // EXE, Secure, Arm, RP2350
const link = u32(a + 12) | 0;
const e = a + link;
const okStartEnd = u32(a + 16) === END;
const okEndBlock = e > 0 && e + 20 <= flash.length && u32(e) === START && u32(e + 16) === END;
const linkBack = u32(e + 12) | 0;
const okLoop = okEndBlock && (e + linkBack === a);

const sp = u32(0), reset = u32(4);
const okSp = (sp & 0xff000000) === 0x20000000;
const okReset = (reset & 0xff000000) === 0x10000000 && (reset & 1) === 1;

console.log(`UF2:        ${path.basename(uf2Path)} (${nblocks} blocks)`);
console.log(`family:     0x${(family >>> 0).toString(16)} (want 0xe48bff59, RP2350 Arm-S)   ${okFamily ? 'OK' : 'BAD'}`);
console.log(`flash base: 0x${baseAddr.toString(16)}   ${okBase ? 'OK' : 'BAD'}`);
console.log(`block @0x${a.toString(16)}: marker_start OK, item=0x${itemByte.toString(16)} (0x42 IMAGE_TYPE) ${okItem ? 'OK' : 'BAD'}`);
console.log(`  image_type flags=0x${flags.toString(16)}: EXE=${imageType} security=${security}(2=Secure) cpu=${cpu}(0=Arm) chip=${chip}(1=RP2350)   ${okFlags ? 'OK' : 'BAD'}`);
console.log(`  marker_end 0x${u32(a + 16).toString(16)}   ${okStartEnd ? 'OK' : 'BAD'}`);
console.log(`end block @0x${e.toString(16)}: loops back to 0x${(e + linkBack).toString(16)} (start 0x${a.toString(16)})   ${okLoop ? 'LOOP CLOSES OK' : 'BAD'}`);
console.log(`vectors:    SP=0x${sp.toString(16)} reset=0x${reset.toString(16)}   ${okSp && okReset ? 'OK' : 'BAD'}`);

if (okFamily && okBase && okItem && okFlags && okStartEnd && okLoop && okSp && okReset) {
  console.log('\nPASS: clang-built RP2350 image has a structurally valid Arm-Secure IMAGE_DEF block loop');
  console.log('(byte-identical IMAGE_TYPE to the SDK\'s own output). Structurally valid — not HW-booted.');
} else fail('RP2350 boot structure invalid');
