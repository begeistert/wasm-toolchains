// scan-libraries.cjs — build the header -> library map that powers automatic
// library resolution (the compiler's "'X.h' not found" loop looks a header up
// here to know which library to download). Run on a schedule (CI cron); the
// output is a small JSON shipped/downloaded by the host app.
//
// Source of truth: the Arduino Library Manager index (library_index.json). Most
// libraries declare their public headers in `providesIncludes` (from
// library.properties `includes=`) — those need NO download. The rest can be
// resolved in --deep mode by fetching the archive and listing its src headers,
// cached by (name, version) so subsequent runs are incremental.
//
// Usage:
//   node scan-libraries.cjs [outFile]            # fast: providesIncludes only
//   node scan-libraries.cjs [outFile] --deep     # also download libs missing it
//   env: INDEX_URL, CACHE_DIR (deep mode), MAX_DEEP (cap downloads per run)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2]
  : path.join(__dirname, 'header-lib-map.json');
const DEEP = process.argv.includes('--deep');
const INDEX_URL = process.env.INDEX_URL || 'https://downloads.arduino.cc/libraries/library_index.json.gz';
const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'libscan-cache');
const MAX_DEEP = parseInt(process.env.MAX_DEEP || '500', 10);
// Libraries that ship inside the avrwasm bundle (dist-web/libraries/). They need
// no download, so they're seeded first and win disambiguation for their headers.
const BUNDLED_DIR = process.env.BUNDLED_DIR || path.resolve(__dirname, '..', '..', 'libraries');

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function loadIndex() {
  const raw = await fetchBuf(INDEX_URL);
  const json = INDEX_URL.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
  return JSON.parse(json.toString()).libraries;
}

// Keep only the newest release of each library name.
function latestByName(libs) {
  const byName = new Map();
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  for (const l of libs) {
    const cur = byName.get(l.name);
    if (!cur || cmp(l.version, cur.version) > 0) byName.set(l.name, l);
  }
  return [...byName.values()];
}

// Deep fallback: download the archive, list *.h/*.hpp under src/ (or root).
async function deepHeaders(lib) {
  const key = `${lib.name}@${lib.version}`.replace(/[^\w.@-]/g, '_');
  const cached = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let headers = [];
  try {
    // Lightweight: peek the zip central directory for header names without a full
    // extract. (A real impl would stream-unzip; here we list via the archive's
    // file table using `unzip -Z1` if available, else skip.)
    const tmp = path.join(CACHE_DIR, `${key}.zip`);
    fs.writeFileSync(tmp, await fetchBuf(lib.url));
    const { execFileSync } = require('child_process');
    const names = execFileSync('unzip', ['-Z1', tmp], { encoding: 'utf8' }).split('\n');
    headers = names.filter((n) => /(^|\/)src\/.*\.(h|hpp)$/.test(n) || /^[^/]+\/[^/]+\.(h|hpp)$/.test(n))
      .map((n) => path.basename(n));
    fs.unlinkSync(tmp);
  } catch (e) { /* network/zip failure → leave empty, retry next run */ }
  fs.writeFileSync(cached, JSON.stringify(headers));
  return headers;
}

// Local, in-bundle libraries (dist-web/libraries/). Parse library.properties for
// name/version/architectures and list the public headers (src/*.h, or root *.h
// for flat-layout libs). These resolve with zero download.
function bundledLibraries() {
  if (!fs.existsSync(BUNDLED_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(BUNDLED_DIR)) {
    const dir = path.join(BUNDLED_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const props = {};
    const pf = path.join(dir, 'library.properties');
    if (fs.existsSync(pf)) for (const line of fs.readFileSync(pf, 'utf8').split('\n')) {
      const m = line.match(/^([^=#]+)=(.*)$/); if (m) props[m[1].trim()] = m[2].trim();
    }
    const srcDir = fs.existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : dir;
    const headers = fs.readdirSync(srcDir).filter((f) => /\.(h|hpp)$/.test(f));
    if (!headers.length) continue;
    out.push({
      name: props.name || name,
      version: props.version || '0.0.0',
      bundled: true,
      architectures: props.architectures ? props.architectures.split(',').map((a) => a.trim()) : ['avr'],
      headers,
    });
  }
  return out;
}

(async () => {
  console.log('fetching', INDEX_URL);
  const libs = latestByName(await loadIndex());
  console.log(`${libs.length} libraries (latest of each)`);

  const map = {};                 // header -> [{ name, version, url|bundled, architectures }]
  const add = (header, lib) => {
    const e = { name: lib.name, version: lib.version, architectures: lib.architectures || ['*'] };
    if (lib.bundled) e.bundled = true; else e.url = lib.url;
    (map[header] ||= []).push(e);
  };

  // Seed bundled libraries first so their headers (Wire.h, SPI.h, EEPROM.h, …)
  // resolve to the in-bundle copy rather than an unrelated third-party library.
  const bundled = bundledLibraries();
  for (const lib of bundled) for (const h of lib.headers) add(h, lib);
  console.log(`${bundled.length} bundled libraries seeded (${bundled.map((b) => b.name).join(', ')})`);

  let declared = 0, deep = 0;
  const missing = [];
  for (const lib of libs) {
    const inc = lib.providesIncludes;
    if (Array.isArray(inc) && inc.length) { for (const h of inc) add(path.basename(h), lib); declared++; }
    else missing.push(lib);
  }
  if (DEEP) {
    for (const lib of missing.slice(0, MAX_DEEP)) {
      for (const h of await deepHeaders(lib)) add(h, lib);
      deep++;
    }
  }

  // Disambiguate: a bundled (in-bundle) library always wins; then prefer an
  // exact-name match; then alphabetical.
  for (const h of Object.keys(map)) {
    map[h].sort((a, b) => {
      if (!!a.bundled !== !!b.bundled) return a.bundled ? -1 : 1;
      const base = h.replace(/\.[^.]+$/, '').toLowerCase();
      const ea = a.name.toLowerCase() === base, eb = b.name.toLowerCase() === base;
      return (eb - ea) || a.name.localeCompare(b.name);
    });
  }

  const out = { generated: new Date().toISOString(), source: INDEX_URL, headers: Object.keys(map).length, map };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`header->lib map: ${out.headers} headers (${declared} via providesIncludes` +
    (DEEP ? `, ${deep} via deep scan, ${missing.length - deep} still missing` : `, ${missing.length} without providesIncludes — run --deep to cover`) +
    `) -> ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
