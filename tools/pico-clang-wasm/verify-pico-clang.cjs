// verify-pico-clang.cjs — prove the PERMISSIVE clang chain end to end: compile
// the bare-metal blink (tools/pico-clang-wasm/demo/blink.c) for both Pico boards
// with clang -> lld -> compiler-rt builtins + picolibc, then assert the artifact
// is a valid ARM firmware: ELF e_machine == 40 (EM_ARM) and a UF2 with the right
// RP family id. Twin of tools/pico-wasm/verify-pico.cjs, but for the clang track.
//
// This runs with a NATIVE LLVM (host clang/ld.lld) against the ARM libs built by
// src/pico-clang/build.sh — the same object files the wasm clang/lld emit, so a
// green run here means the toolchain inputs are correct. The wasm end-to-end
// (clang.wasm/lld.wasm in a WebView) reuses recipe-pico-clang.js.
//
//   node verify-pico-clang.cjs <llvm-bin-dir> <armlibs-dir>
// where <armlibs-dir> is src/pico-clang/build.sh's OUT (lib/<board>/...).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { target } = require('../targets/registry.cjs');
const { binToUf2 } = require('./recipe-pico-clang.js');

const L = path.resolve(process.argv[2] || '/opt/homebrew/opt/llvm/bin');
const ARMLIBS = path.resolve(process.argv[3] || 'dist-pico-clang-armlibs');
const HERE = __dirname;
const T = target('pico-clang-toolchain');
const bin = (n) => path.join(L, n);
const lld = fs.existsSync(bin('ld.lld')) ? bin('ld.lld')
  : (fs.existsSync('/opt/homebrew/bin/ld.lld') ? '/opt/homebrew/bin/ld.lld' : 'ld.lld');

function le32(buf, o) { return buf.readUInt32LE(o); }
let fail = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclang-'));

for (const b of T.boards) {
  const libdir = path.join(ARMLIBS, 'lib', b.key);
  const builtins = fs.readdirSync(libdir).find((f) => /^libclang_rt\.builtins-.*\.a$/.test(f));
  const inc = path.join(libdir, 'picolibc', 'include');
  const plib = path.join(libdir, 'picolibc', 'lib');
  const obj = path.join(tmp, `${b.key}.o`), elf = path.join(tmp, `${b.key}.elf`), rawbin = path.join(tmp, `${b.key}.bin`);

  // clang: blink.c -> object (integrated assembler)
  execFileSync(bin('clang'), [
    `--target=${b.triple}`, ...b.clangFlags, '-Os', '-ffreestanding', '-nostdlib',
    '-isystem', inc, '-c', path.join(HERE, 'demo', 'blink.c'), '-o', obj,
  ], { stdio: 'pipe' });

  // lld: object + picolibc libc + compiler-rt builtins -> ELF
  execFileSync(lld, [
    '-o', elf, '-T', path.join(HERE, 'demo', 'rp2040.ld'), '--gc-sections',
    obj, `-L${plib}`, '-lc', path.join(libdir, builtins),
  ], { stdio: 'pipe' });

  // assert EM_ARM (e_machine at ELF header offset 18, 2 bytes LE) == 40
  const eh = fs.readFileSync(elf);
  const emach = eh.readUInt16LE(18);
  const isElf = eh.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

  execFileSync(bin('llvm-objcopy'), ['-O', 'binary', elf, rawbin], { stdio: 'pipe' });
  const uf2 = Buffer.from(binToUf2(new Uint8Array(fs.readFileSync(rawbin)), parseInt(b.family, 16)));
  const uf2ok = le32(uf2, 0) === 0x0a324655 && le32(uf2, 4) === 0x9e5d5157 &&
    le32(uf2, 28) === (parseInt(b.family, 16) >>> 0) && le32(uf2, uf2.length - 4) === 0x0ab16f30;

  const ok = isElf && emach === 40 && uf2ok;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${b.key} (${b.mcu}, ${b.triple}): ` +
    `ELF=${isElf} e_machine=${emach}(want 40) builtins=${builtins} ` +
    `UF2 family=0x${(parseInt(b.family, 16) >>> 0).toString(16)} magic=${uf2ok} (${uf2.length} B)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fail) { console.error(`\n${fail} board(s) FAILED`); process.exit(1); }
console.log('\nAll boards: clang -> lld -> compiler-rt + picolibc produced valid ARM (EM_ARM) firmware.');
