// make-esp-dist.fixture.cjs — exercise the ESP bundle assembler end-to-end with a
// synthetic harvest (no Docker, no real toolchain), for BOTH chips. Asserts each
// chip gets its own bundle with its own tools, the header closure + link inputs are
// captured, and the manifest carries the chip's flash offsets + output=bin.
// Run: node tools/esp-wasm/make-esp-dist.fixture.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { bundlesForTrack } = require('../targets/registry.cjs');

const SCRATCH = process.env.SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'espdist-fix-'));
const ROOT = path.join(SCRATCH, 'esproot');
const TMP = path.join(SCRATCH, 'tmp');
const OUTBASE = path.join(SCRATCH, 'out');
for (const d of [ROOT, TMP, OUTBASE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(TMP, 'ginc.txt'), '/root/inc/c++\n');

const root = (rel, bytes) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return '/' + rel; };

const esp = bundlesForTrack('esp-v');
assert.deepStrictEqual(esp.map((t) => t.chip).sort(), ['esp32', 'esp32c3'], 'esp track must hold both chips');

// Per-chip synthetic harvest: one shared header, a core.a, a sketch obj.
const distArmEnv = {};
for (const t of esp) {
  const board = t.boards[0];
  const hdr = root(`root/${t.chip}/sdk/Arduino.h`, `// ${t.chip}`);
  const core = root(`root/${t.chip}/core/core.a`, `core for ${t.chip}`);
  const sketchSrc = `/root/${t.chip}/sketch/Big_${board.tag}.ino.cpp`;
  root(sketchSrc.slice(1), `// sketch ${t.chip}`);
  const obj = `/root/${t.chip}/sketch/Big_${board.tag}.ino.cpp.o`;
  fs.writeFileSync(path.join(TMP, `closure-big-${board.key}.txt`), hdr + '\n');
  fs.writeFileSync(path.join(TMP, `big-${board.key}-cc1plus.txt`),
    `=== cc1plus\n/usr/bin/cc1plus\n${sketchSrc}\n-o\n/work/s.s\n`);
  fs.writeFileSync(path.join(TMP, `big-${board.key}-ld.txt`),
    ['=== ld', '/usr/bin/ld', `-L/root/${t.chip}/core`, core, obj, '-o', `/root/${t.chip}/Big.elf`].join('\n') + '\n');

  // Stub the per-chip ARM-style tool dir (dist-<chip>-gcc) with the names the
  // assembler maps. as/ld prefix follows the gccTarget (riscv32 / xtensa).
  const as = t.gccTarget.replace('-esp-elf', '');
  const distArm = path.join(SCRATCH, `dist-${t.chip}-gcc`);
  fs.mkdirSync(distArm, { recursive: true });
  for (const f of ['cc1plus.js', 'cc1plus.wasm', `${as}-as.js`, `${as}-as.wasm`, `${as}-ld.js`, `${as}-ld.wasm`, 'objcopy.js', 'objcopy.wasm'])
    fs.writeFileSync(path.join(distArm, f), `stub:${t.chip}:${f}`);   // chip-specific so cross-bundle distinctness is real
  distArmEnv[`DIST_ESP_${t.chip.toUpperCase()}`] = distArm;
}

execFileSync('node', [path.join(__dirname, 'make-esp-dist.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, ESPROOT: ROOT, ESP_TMP: TMP, ESP_ISYSTEM: path.join(TMP, 'ginc.txt'), ESP_OUT_BASE: OUTBASE, ...distArmEnv },
});

for (const t of esp) {
  const dir = path.join(OUTBASE, t.distDir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.chip, t.chip, `${t.chip}: manifest chip`);
  assert.strictEqual(m.output, 'bin', `${t.chip}: esp output is a flash image`);
  assert.deepStrictEqual(m.flash, t.flash, `${t.chip}: flash offsets must reach the manifest`);
  const as = t.gccTarget.replace('-esp-elf', '');
  assert.ok(fs.existsSync(path.join(dir, 'tools', `${as}-as.js`)), `${t.chip}: own ${as}-as.js`);
  assert.ok(fs.existsSync(path.join(dir, 'tools', 'cc1plus.wasm')), `${t.chip}: own cc1plus.wasm`);
  const b = m.boards[t.boards[0].key];
  assert.ok(b.headers.length === 1 && b.link.length === 1, `${t.chip}: closure + link captured`);
  assert.ok(b.link[0].endsWith('core/core.a'), `${t.chip}: core.a in link inputs`);
  assert.deepStrictEqual(b.asFlags, t.boards[0].asFlags, `${t.chip}: asFlags`);
}
// The two chips must not share tool bytes (different ISA).
const a = fs.readFileSync(path.join(OUTBASE, 'dist-esp32-web/tools/cc1plus.js'));
const c = fs.readFileSync(path.join(OUTBASE, 'dist-esp32c3-web/tools/cc1plus.js'));
assert.ok(!a.equals(c), 'esp32 and esp32c3 must ship distinct toolchains');

console.log('make-esp-dist.fixture.cjs: both esp bundles built, flash offsets + per-chip tools verified');
if (!process.env.SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
