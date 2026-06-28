// make-llvm-dist.fixture.cjs — exercise the LLVM bundle assembler with stub tool
// files (no Docker / no real LLVM). Asserts the manifest names every tool + the
// multi-target triple list, and that big artifacts get a brotli sidecar.
// Run: node tools/llvm-wasm/make-llvm-dist.fixture.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { target } = require('../targets/registry.cjs');

const T = target('llvm-toolchain');
const SCRATCH = process.env.SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'llvmdist-fix-'));
const SRC = path.join(SCRATCH, 'dist-llvm');
const OUT = path.join(SCRATCH, 'dist-llvm-web');
fs.mkdirSync(SRC, { recursive: true });

// Stub each tool: a small .js loader + a >64 KiB .wasm so brotli kicks in.
const big = Buffer.alloc(70 * 1024, 7);
for (const t of T.llvmTools) {
  fs.writeFileSync(path.join(SRC, `${t}.js`), `// stub ${t}\n`);
  fs.writeFileSync(path.join(SRC, `${t}.wasm`), big);
}

execFileSync('node', [path.join(__dirname, 'make-llvm-dist.cjs'), OUT, SRC], { stdio: 'inherit' });

const m = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
assert.strictEqual(m.llvm, T.llvm, 'manifest must carry the llvm version');
for (const t of T.llvmTools) {
  assert.ok(fs.existsSync(path.join(OUT, 'tools', `${t}.js`)), `missing ${t}.js`);
  assert.ok(fs.existsSync(path.join(OUT, 'tools', `${t}.wasm`)), `missing ${t}.wasm`);
  assert.ok(fs.existsSync(path.join(OUT, 'tools', `${t}.wasm.br`)), `missing brotli for ${t}.wasm`);
  assert.ok(m.tools.includes(path.join('tools', `${t}.js`)), `${t}.js not in manifest`);
}
// Multi-target: every configured triple is advertised, xtensa flagged experimental.
const want = [...T.llvmTargets, ...T.llvmExperimentalTargets].map((s) => s.toLowerCase());
assert.deepStrictEqual(m.targets.sort(), want.sort(), 'manifest targets must match the configured backends');
assert.ok(m.experimental.includes('xtensa'), 'xtensa must be flagged experimental');

console.log(`make-llvm-dist.fixture.cjs: ${T.llvmTools.length} tools, targets [${m.targets.join(',')}] — assertions passed`);
if (!process.env.SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
