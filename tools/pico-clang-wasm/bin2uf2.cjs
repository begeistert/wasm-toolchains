// bin2uf2.cjs — flash .bin -> .uf2 for the pico-clang track, reusing the exact
// binToUf2 from recipe-pico-clang.js (RP2040 0xe48bff56 / RP2350 0xe48bff59).
//   node bin2uf2.cjs <in.bin> <family-hex> <out.uf2>
'use strict';
const fs = require('fs');
const { binToUf2 } = require('./recipe-pico-clang.js');
const [, , inBin, familyArg, outUf2] = process.argv;
if (!inBin || !familyArg || !outUf2) { console.error('usage: bin2uf2.cjs <in.bin> <family-hex> <out.uf2>'); process.exit(2); }
const family = parseInt(familyArg, 16) >>> 0;
const uf2 = binToUf2(new Uint8Array(fs.readFileSync(inBin)), family);
fs.writeFileSync(outUf2, Buffer.from(uf2));
console.log(`${outUf2}: ${uf2.length} bytes, ${uf2.length / 512} blocks, family 0x${family.toString(16)}`);
