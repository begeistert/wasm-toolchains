// make-llvm-dist.cjs — assemble the shippable LLVM IR backend bundle, twin of
// arduino-wasm/make-web-dist.cjs and pico-wasm/make-pico-dist.cjs.
//
// The src/llvm build emits a multi-target backend: one llc.wasm / opt.wasm /
// lld.wasm / llvm-mc.wasm / llvm-objcopy.wasm that compiles LLVM IR (.ll/.bc) to
// object code and links it for ANY arch the backend was built with (ARM, AArch64,
// RISC-V, AVR + experimental Xtensa) — the target is chosen by the IR's triple or
// `-mtriple`, not by a different binary. So unlike the GCC tracks there is no
// per-board sysroot here; the bundle is just the tools + a manifest naming which
// target triples they can lower to.
//
// Inputs: the raw Docker build output (dist-llvm/ by default, or argv[3]).
// Output: dist-llvm-web/ with tools/ + manifest.json, brotli-compressed like the
// other bundles (the iOS host serves .br with Content-Encoding: br).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { target } = require('../targets/registry.cjs');

const AVR = path.resolve(__dirname, '..', '..');
const T = target('llvm-toolchain');
const SRC = path.resolve(process.argv[3] || process.env.DIST_LLVM || path.join(AVR, 'dist-llvm'));
const OUT = path.resolve(process.argv[2] || path.join(AVR, T.distDir));

const rd = (f) => fs.readFileSync(f);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copy(src, dstRel) {
  const dst = path.join(OUT, dstRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, rd(src));
  return dstRel;
}

// Tool modules: each LLVM tool ships as a .js loader + .wasm sidecar.
const manifest = {
  llvm: T.llvm,
  // Target triples the single backend can lower to (lowercased arch keys); the
  // host passes the matching -mtriple. Experimental targets are flagged.
  targets: [...T.llvmTargets, ...(T.llvmExperimentalTargets || [])].map((s) => s.toLowerCase()),
  experimental: (T.llvmExperimentalTargets || []).map((s) => s.toLowerCase()),
  tools: [],
};
for (const tool of T.llvmTools) {
  for (const ext of ['js', 'wasm']) {
    const src = path.join(SRC, `${tool}.${ext}`);
    if (!fs.existsSync(src)) {
      if (ext === 'wasm') continue;   // single-file .js tools have no sidecar
      throw new Error(`make-llvm-dist: missing ${tool}.${ext} in ${SRC}`);
    }
    manifest.tools.push(copy(src, path.join('tools', `${tool}.${ext}`)));
  }
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Brotli the big artifacts (.wasm/.js) for shipping — same convention as the
// other bundles. ~3x on raw wasm; the host inflates via Content-Encoding: br.
let raw = 0, ship = 0;
const all = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name); e.isDirectory() ? walk(f) : all.push(f); } })(OUT);
for (const f of all) {
  const sz = fs.statSync(f).size; raw += sz;
  if (/\.(wasm|js)$/.test(f) && sz > 65536) {
    const br = zlib.brotliCompressSync(rd(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
    fs.writeFileSync(f + '.br', br); ship += br.length;
  } else ship += sz;
}
console.log(`llvm dist ready: ${T.llvmTools.length} tools (${manifest.targets.join(',')}) — ` +
  `${(raw / 1048576).toFixed(1)} MB raw, ${(ship / 1048576).toFixed(1)} MB shipped (brotli where available).`);
