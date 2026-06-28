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
const { loadAll } = require('../targets/registry.cjs');

const VERSION = process.argv[2] || '0.0.0';
const STAGE = process.argv[3] || path.resolve(__dirname, '../../dist-release');
const BASE = process.argv[4] || `https://github.com/begeistert/wasm-toolchains/releases/download/v${VERSION}`;
const AVR = path.resolve(__dirname, '..', '..');

fs.mkdirSync(STAGE, { recursive: true });
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Bundles to publish come from the target registry (targets/*.json) — the same
// source of truth the build/harvest scripts read. Only pinned, versioned
// toolchains belong in a release catalog; each descriptor that names a `tar`
// (its distDir tarball) is publishable. An overlay (e.g. pico-wireless) carries
// `requires` so the host knows to fetch its base bundle first.
//
// The header→library map is intentionally NOT here: it changes weekly (Arduino
// library ecosystem) and ships via its own rolling `library-index` release,
// which the host app reads directly — pinning a rolling artifact's sha256 in a
// versioned catalog would only go stale.
const BUNDLES = Object.values(loadAll())
  .filter((t) => t.tar && t.distDir)
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((t) => ({
    id: t.id,
    dir: path.join(AVR, t.distDir),
    tar: t.tar,
    ...(t.extends ? { requires: t.extends } : {}),
  }));

const entries = [];
for (const b of BUNDLES) {
  const dst = path.join(STAGE, b.tar);
  if (!fs.existsSync(b.dir)) { console.warn(`skip ${b.id}: ${b.dir} missing`); continue; }
  execFileSync('tar', ['cf', dst, '-C', b.dir, '.']);
  const st = fs.statSync(dst);
  const entry = { id: b.id, file: b.tar, url: `${BASE}/${b.tar}`, bytes: st.size, sha256: sha256(dst) };
  if (b.requires) entry.requires = b.requires;
  entries.push(entry);
  console.log(`${b.id}: ${b.tar} ${(st.size / 1048576).toFixed(1)} MB`);
}

const catalog = { version: VERSION, generated: new Date().toISOString(), bundles: entries };
fs.writeFileSync(path.join(STAGE, 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`catalog.json -> ${STAGE} (${entries.length} bundles, version ${VERSION})`);
