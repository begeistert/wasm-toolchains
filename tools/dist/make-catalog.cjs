// make-catalog.cjs — produce catalog.json, the versioned manifest the host app reads
// to know which on-device-compiler blobs to download (the GPL toolchains ship as
// runtime-downloaded blobs, not bundled in the app — see docs/LICENSING.md). Each
// entry is a tarball published to the GitHub Release, with a sha256 so the client
// can verify + cache. Bump `version` and re-release to push a toolchain update
// without an App Store release.
//
// Usage: node tools/dist/make-catalog.cjs <version> <stageDir> [release-base-url]
//   stageDir holds the artifacts to publish; we tar+hash each known bundle there.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = process.argv[2] || '0.0.0';
const STAGE = process.argv[3] || path.resolve(__dirname, '../../dist-release');
const BASE = process.argv[4] || `https://github.com/begeistert/wasm-toolchains/releases/download/v${VERSION}`;
const AVR = path.resolve(__dirname, '..', '..');

fs.mkdirSync(STAGE, { recursive: true });
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Bundles to publish: id -> source dir (a web bundle) or file.
const BUNDLES = [
  { id: 'avr-toolchain',  dir: path.join(AVR, 'dist-web'),       tar: 'avrwasm.tar' },
  { id: 'pico-toolchain', dir: path.join(AVR, 'dist-pico-web'),  tar: 'picowasm.tar' },
  { id: 'header-lib-map', file: path.join(AVR, 'tools/lib-index/header-lib-map.json'), tar: 'header-lib-map.json' },
];

const entries = [];
for (const b of BUNDLES) {
  const dst = path.join(STAGE, b.tar);
  if (b.dir) {
    if (!fs.existsSync(b.dir)) { console.warn(`skip ${b.id}: ${b.dir} missing`); continue; }
    execFileSync('tar', ['cf', dst, '-C', b.dir, '.']);
  } else {
    if (!fs.existsSync(b.file)) { console.warn(`skip ${b.id}: ${b.file} missing`); continue; }
    fs.copyFileSync(b.file, dst);
  }
  const st = fs.statSync(dst);
  entries.push({ id: b.id, file: b.tar, url: `${BASE}/${b.tar}`, bytes: st.size, sha256: sha256(dst) });
  console.log(`${b.id}: ${b.tar} ${(st.size / 1048576).toFixed(1)} MB`);
}

const catalog = { version: VERSION, generated: new Date().toISOString(), bundles: entries };
fs.writeFileSync(path.join(STAGE, 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`catalog.json -> ${STAGE} (${entries.length} bundles, version ${VERSION})`);
