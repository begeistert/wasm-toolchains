// make-pico-clang-dist.cjs — assemble the shippable PERMISSIVE Pico (clang)
// bundle, twin of pico-wasm/make-pico-dist.cjs but for the non-GPL clang stack.
//
// Unlike the GCC track there is no per-arch cc1plus: ONE clang.wasm frontend +
// ONE lld.wasm serve both boards; only the TARGET link inputs differ per board
// (compiler-rt builtins + picolibc, built by src/pico-clang/build.sh). So the
// bundle is: tools/ (clang, lld, llvm-objcopy wasm — permissive) + resource/
// (clang's own intrinsic headers) + lib/<board>/ (the ARM libs) + manifest.json.
//
// Inputs (env or argv):
//   argv[2]              output dir           (default dist-pico-clang-web)
//   PICO_CLANG_ARMLIBS   dir with lib/<board>/{libclang_rt.builtins-*.a,picolibc/}
//                        as produced by src/pico-clang/build.sh (OUT)
//   PICO_CLANG_WASM      dir with clang.js/clang.wasm + lib/clang/<v>/include
//                        (the prebuilt clang track) and lld.*/llvm-objcopy.*
//                        (the llvm track); may be one merged dir or see below.
//   CLANG_WASM_DIR       override: dir holding clang.{js,wasm} + lib/clang/...
//   LLVM_WASM_DIR        override: dir holding lld.{js,wasm} + llvm-objcopy.{js,wasm}
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { target } = require('../targets/registry.cjs');

const AVR = path.resolve(__dirname, '..', '..');
const T = target('pico-clang-toolchain');
const OUT = path.resolve(process.argv[2] || path.join(AVR, T.distDir));
const ARMLIBS = path.resolve(process.env.PICO_CLANG_ARMLIBS || path.join(AVR, 'dist-pico-clang-armlibs'));
const WASM = process.env.PICO_CLANG_WASM || '';
const CLANG_DIR = process.env.CLANG_WASM_DIR || (WASM && path.join(WASM, 'clang'));
const LLVM_DIR = process.env.LLVM_WASM_DIR || (WASM && path.join(WASM, 'llvm', 'tools'));

const rd = (f) => fs.readFileSync(f);
function copy(src, dstRel) {
  const dst = path.join(OUT, dstRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, rd(src));
  return dstRel;
}
function copyTree(srcDir, dstRel) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const s = path.join(d, e.name), r = path.join(rel, e.name);
      if (e.isDirectory()) walk(s, r);
      else out.push(copy(s, r));
    }
  })(srcDir, dstRel);
  return out;
}
function firstExisting(cands, what) {
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  throw new Error(`make-pico-clang-dist: cannot find ${what} (looked in: ${cands.filter(Boolean).join(', ')})`);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 1. wasm tools (permissive: Apache-2.0-with-LLVM-exception) ──────────────
const manifest = {
  llvm: T.llvm, picolibc: T.picolibc, license: T.license, wip: !!T.wip,
  output: T.output, tools: [], resourceDir: null, boards: [],
};
// clang.wasm + loader
const clangJs = firstExisting([CLANG_DIR && path.join(CLANG_DIR, 'clang.js')], 'clang.js');
const clangDir = path.dirname(clangJs);
manifest.tools.push(copy(clangJs, 'tools/clang.js'));
manifest.tools.push(copy(path.join(clangDir, 'clang.wasm'), 'tools/clang.wasm'));
// lld + llvm-objcopy
const lldJs = firstExisting([LLVM_DIR && path.join(LLVM_DIR, 'lld.js')], 'lld.js');
const lldDir = path.dirname(lldJs);
for (const t of ['lld', 'llvm-objcopy']) {
  manifest.tools.push(copy(path.join(lldDir, `${t}.js`), `tools/${t}.js`));
  manifest.tools.push(copy(path.join(lldDir, `${t}.wasm`), `tools/${t}.wasm`));
}

// ── 2. clang resource headers (stddef/stdint/intrinsics) ────────────────────
const resSrc = firstExisting([
  ...['19', '18', '20', '17'].map((v) => path.join(clangDir, 'lib', 'clang', v, 'include')),
], "clang resource headers (lib/clang/<v>/include)");
manifest.resourceDir = 'resource/' + path.relative(path.join(clangDir, 'lib'), path.dirname(resSrc));
copyTree(resSrc, path.join('resource', path.relative(path.join(clangDir, 'lib'), path.dirname(resSrc)), 'include'));

// ── 3. per-board ARM link inputs (compiler-rt builtins + picolibc) ──────────
for (const b of T.boards) {
  const libSrc = path.join(ARMLIBS, 'lib', b.key);
  if (!fs.existsSync(libSrc)) throw new Error(`make-pico-clang-dist: missing ARM libs for ${b.key} at ${libSrc} (run src/pico-clang/build.sh)`);
  const files = copyTree(libSrc, path.join('lib', b.key));
  const builtins = files.find((f) => /libclang_rt\.builtins-.*\.a$/.test(f));
  manifest.boards.push({
    key: b.key, mcu: b.mcu, family: b.family, triple: b.triple, clangFlags: b.clangFlags,
    builtins, libc: files.find((f) => /picolibc\/lib\/libc\.a$/.test(f)),
    crt0: files.find((f) => /picolibc\/lib\/crt0\.o$/.test(f)),
    include: `lib/${b.key}/picolibc/include`,
    linkerScript: files.find((f) => /picolibc\.ld$/.test(f)) || null,
  });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ── 4. brotli the big artifacts (same convention as the other bundles) ──────
let raw = 0, ship = 0;
const all = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name); e.isDirectory() ? walk(f) : all.push(f); } })(OUT);
for (const f of all) {
  const sz = fs.statSync(f).size; raw += sz;
  if (/\.(wasm|js|a)$/.test(f) && sz > 65536) {
    const br = zlib.brotliCompressSync(rd(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
    fs.writeFileSync(f + '.br', br); ship += br.length;
  } else ship += sz;
}
console.log(`pico-clang dist ready: ${manifest.tools.length / 2} wasm tools + ${manifest.boards.length} boards ` +
  `(${manifest.boards.map((b) => b.key).join(',')}) — ${(raw / 1048576).toFixed(1)} MB raw, ` +
  `${(ship / 1048576).toFixed(1)} MB shipped (brotli where available). WIP=${manifest.wip}.`);
