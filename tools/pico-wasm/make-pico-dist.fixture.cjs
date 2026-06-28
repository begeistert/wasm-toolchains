// make-pico-dist.fixture.cjs — exercise the base/overlay split end-to-end with a
// tiny synthetic harvest (no Docker, no real toolchain). Builds a fake PICOROOT
// where the base boards (pico/pico2) and the wireless boards (pico_w/pico2w) share
// most vfs files but each W board also pulls one W-only file, then asserts:
//   • base bundle ships the tools + the shared vfs; no W-only files
//   • overlay ships NO tools, only the W-only delta, and manifest.extends is set
//   • every board manifest references the right vfs paths
// Run: node tools/pico-wasm/make-pico-dist.fixture.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const SCRATCH = process.env.SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'picodist-fix-'));
const PICOROOT = path.join(SCRATCH, 'picoroot');
const TMP = path.join(SCRATCH, 'tmp');
const ARM = path.join(SCRATCH, 'arm');
const OUT = path.join(SCRATCH, 'dist-pico-web');
for (const d of [PICOROOT, TMP, ARM, path.join(TMP)]) fs.mkdirSync(d, { recursive: true });

// Stub ARM tools (content irrelevant; the splitter only copies bytes).
for (const f of ['cc1plus.js', 'cc1plus.wasm', 'arm-as.js', 'arm-as.wasm', 'arm-ld.js', 'arm-ld.wasm', 'objcopy.js', 'objcopy.wasm'])
  fs.writeFileSync(path.join(ARM, f), `stub:${f}`);
fs.writeFileSync(path.join(TMP, 'ginc.txt'), '/root/inc/c++\n');

// A vfs file under PICOROOT, returning its absolute /root path.
const root = (rel, bytes) => { const p = path.join(PICOROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return '/' + rel; };

// Shared SDK header + shared link archive (same path for every board → dedup).
const sharedHdr = root('root/sdk/pico/stdlib.h', 'shared header');
const sharedLib = root('root/sdk/lib/rp/libpico.a', 'shared archive');

// Per-board harvest artifacts. Each W board adds one W-only file under its own
// (sketch-hash) cache dir, mirroring how arduino-cli paths the wireless core.a.
function harvest(key, tag, withWifi) {
  const sketchSrc = `/root/.cache/${tag}/sketch/Big_${tag}.ino.cpp`;
  root(sketchSrc.slice(1), `// ${tag} sketch`);
  const headers = [sharedHdr];
  const links = [sharedLib];
  if (withWifi) {
    const wifi = root(`root/.cache/${tag}/core/core.a`, `WIFI-BT core for ${tag}`);
    links.push(wifi);
  }
  fs.writeFileSync(path.join(TMP, `closure-big-${key}.txt`), headers.join('\n') + '\n');
  // cc1plus argv: an exec line (filtered out) + the sketch source line.
  fs.writeFileSync(path.join(TMP, `big-${key}-cc1plus.txt`),
    `=== cc1plus\n/usr/bin/cc1plus\n${sketchSrc}\n-o\n/work/s.s\n`);
  // ld argv: -L dir, the shared archive, an optional W archive, the sketch object, -o elf.
  const obj = `/root/.cache/${tag}/sketch/Big_${tag}.ino.cpp.o`;
  const lines = ['=== ld', '/usr/bin/ld', '-L/root/sdk/lib/rp', sharedLib];
  if (withWifi) lines.push(`/root/.cache/${tag}/core/core.a`);
  lines.push(obj, '-o', `/root/.cache/${tag}/Big_${tag}.ino.elf`);
  fs.writeFileSync(path.join(TMP, `big-${key}-ld.txt`), lines.join('\n') + '\n');
}
harvest('pico', 'pico', false);
harvest('pico2', 'pico2', false);
harvest('pico_w', 'picow', true);
harvest('pico2w', 'pico2w', true);

execFileSync('node', [path.join(HERE, 'make-pico-dist.cjs'), OUT], {
  stdio: 'inherit',
  env: { ...process.env, PICOROOT, PICO_TMP: TMP, PICO_ISYSTEM: path.join(TMP, 'ginc.txt'), DIST_ARM: ARM, PICO_BOARDS: '' },
});

const OVL = path.join(SCRATCH, 'dist-pico-wireless');
const exists = (p) => fs.existsSync(p);
const readManifest = (d) => JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));

// ── base bundle ─────────────────────────────────────────────────────────────
const base = readManifest(OUT);
assert.deepStrictEqual(Object.keys(base.boards).sort(), ['pico', 'pico2'], 'base must hold only non-W boards');
assert.ok(exists(path.join(OUT, 'tools/cc1plus.wasm')), 'base must ship the tools');
assert.ok(!base.extends, 'base must not declare extends');
assert.ok(exists(path.join(OUT, 'vfs/root/sdk/lib/rp/libpico.a')), 'base must ship the shared archive');
assert.ok(!exists(path.join(OUT, 'vfs/root/.cache/picow/core/core.a')), 'base must NOT ship W-only files');

// ── overlay bundle ──────────────────────────────────────────────────────────
assert.ok(exists(OVL), 'overlay dir must be produced');
const ovl = readManifest(OVL);
assert.deepStrictEqual(Object.keys(ovl.boards).sort(), ['pico2w', 'pico_w'], 'overlay must hold only W boards');
assert.strictEqual(ovl.extends, 'pico-toolchain', 'overlay must declare its base');
assert.ok(!exists(path.join(OVL, 'tools/cc1plus.wasm')), 'overlay must NOT re-ship tools');
assert.ok(!exists(path.join(OVL, 'vfs/root/sdk/lib/rp/libpico.a')), 'overlay must NOT re-ship base-shared vfs');
assert.ok(exists(path.join(OVL, 'vfs/root/.cache/picow/core/core.a')), 'overlay must ship the W-only core.a');
assert.ok(exists(path.join(OVL, 'vfs/root/.cache/pico2w/core/core.a')), 'overlay must ship the W-only core.a');

// overlay W board still REFERENCES the shared base vfs (resolved post-extract).
assert.ok(ovl.boards.pico_w.link.includes('vfs/root/sdk/lib/rp/libpico.a'), 'W board must reference the shared archive');
assert.ok(ovl.boards.pico_w.link.includes('vfs/root/.cache/picow/core/core.a'), 'W board must reference its W core.a');
assert.ok(ovl.tools.includes(path.join('tools', 'cc1plus.js')) || ovl.tools.includes('tools/cc1plus.js'),
  'overlay manifest must still reference the base-supplied tools');

// True delta: no vfs file is shipped by BOTH bundles (the whole point — the host
// never downloads a shared blob twice). The tool-size win is real at scale (~40 MB
// of tools live only in the base); we assert the dedup invariant instead, which a
// toy fixture with stub tools can check honestly.
const vfsTree = (d) => { const s = new Set(); const r = path.join(d, 'vfs'); if (!fs.existsSync(r)) return s; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); e.isDirectory() ? w(f) : s.add(path.relative(d, f)); } })(r); return s; };
const baseVfs = vfsTree(OUT), ovlVfs = vfsTree(OVL);
const overlap = [...ovlVfs].filter((r) => baseVfs.has(r));
assert.deepStrictEqual(overlap, [], `overlay must not duplicate base vfs files: ${overlap.join(', ')}`);
assert.ok(ovlVfs.size > 0 && [...ovlVfs].every((r) => /core\.a$|\.ino\.cpp\.o$/.test(r)), 'overlay vfs must be W-only delta');
console.log(`fixture: base ships ${baseVfs.size} vfs files, overlay ships ${ovlVfs.size} (zero overlap)`);

console.log('make-pico-dist.fixture.cjs: all split/overlay assertions passed');
if (!process.env.SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
