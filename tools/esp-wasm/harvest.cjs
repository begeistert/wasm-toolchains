// harvest.cjs — host orchestrator for the ESP32 bundles. Twin of
// pico-wasm/harvest.cjs, registry-driven over the esp-v track's chips (esp32 =
// Xtensa, esp32c3 = RISC-V). For each chip's board it drives the espcap container
// to capture the cc1plus/ld invocations + the precompiled link inputs a native
// arduino-cli build produces, computes the header closure with that chip's WASM
// cc1plus, then builds the shippable bundles (make-esp-dist.cjs).
//
//   1. run tools/esp-wasm/harvest.sh in espcap for each board (per gcc target)
//   2. tar the 3rd-party library sources (board-agnostic) once
//   3. extract everything into an ESPROOT mirror
//   4. pick the real cc1plus block (all libs) + the final ld block per board
//   5. compute the header closure (cc1plus -H) from each chip's WASM toolchain
//   6. invoke make-esp-dist.cjs → dist-<chip>-web/
//
// Usage: node tools/esp-wasm/harvest.cjs
//   env: ESPCAP_IMAGE (default espcap:latest), WORK (scratch, default $TMPDIR/espharvest),
//        DIST_ESP_<CHIP> (per-chip ARM-style tool dir, default dist-<chip>-gcc)
//
// NOTE: arduino-esp32 is ESP-IDF based and heavier than arduino-pico; the toolchain
// include layout is discovered (not pinned). CI-validated (release-esp.yml); expect
// to tune gincDirs() to the pinned core's newlib/gcc include tree on first run.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { bundlesForTrack } = require('../targets/registry.cjs');

const HERE = __dirname;
const AVR = path.resolve(HERE, '..', '..');
const IMAGE = process.env.ESPCAP_IMAGE || 'espcap:latest';
const WORK = process.env.WORK || path.join(require('os').tmpdir(), 'espharvest');
const ESPROOT = path.join(WORK, 'esproot');

// Flatten the track into per-board harvest units: { chip, key, fqbn, tag, gccTarget }.
const UNITS = bundlesForTrack('esp-v').flatMap((t) =>
  t.boards.map((b) => ({ chip: t.chip, gccTarget: t.gccTarget, ...b })));

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const dockerRun = (extra) => sh('docker', ['run', '--rm', '-v', `${WORK}:/out`, IMAGE, ...extra]);

function harvest() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'harvest.sh'), path.join(WORK, 'harvest.sh'));
  // Reuse the pico kitchen-sink sketch (Tier-1 libs are board-agnostic).
  fs.copyFileSync(path.join(AVR, 'tools/pico-wasm/bigsketch.ino'), path.join(WORK, 'bigsketch.ino'));
  for (const u of UNITS) {
    console.log(`\n=== harvest ${u.tag} (${u.fqbn}, ${u.gccTarget}) ===`);
    dockerRun(['bash', '/out/harvest.sh', u.fqbn, u.tag, u.gccTarget]);
  }
  console.log('\n=== tar 3rd-party library sources ===');
  dockerRun(['bash', '-lc', 'tar cf /out/arduinolibs.tar /root/Arduino/libraries 2>/dev/null || true']);
}

function extract() {
  fs.rmSync(path.join(ESPROOT, 'root', '.cache', 'arduino', 'sketches'), { recursive: true, force: true });
  fs.mkdirSync(ESPROOT, { recursive: true });
  const untar = (f) => { if (fs.existsSync(f)) sh('tar', ['xf', f, '-C', ESPROOT]); };
  // The esp32 hardware tree + the per-chip toolchains come from the image; tar the
  // packages tree once (headers + precompiled core per chip).
  dockerRun(['bash', '-lc',
    'tar cf /out/hwtc.tar /root/.arduino15/packages/esp32/hardware/esp32 /root/.arduino15/packages/esp32/tools 2>/dev/null || true']);
  untar(path.join(WORK, 'hwtc.tar'));
  untar(path.join(WORK, 'arduinolibs.tar'));
  for (const u of UNITS) untar(path.join(WORK, `cacheb-${u.tag}.tar`));
}

// Discover the toolchain -isystem dirs for one gcc target from the extracted tree.
function gincDirs(gccTarget) {
  const toolsBase = path.join(ESPROOT, 'root/.arduino15/packages/esp32/tools');
  const found = [];
  const want = [`${gccTarget}/include/c++`, `${gccTarget}/include`, 'include', 'include-fixed'];
  (function walk(d, depth) {
    if (depth > 8 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const f = path.join(d, e.name);
      if (want.some((w) => f.endsWith(w)) && f.includes(gccTarget)) found.push('/' + path.relative(ESPROOT, f));
      walk(f, depth + 1);
    }
  })(toolsBase, 0);
  return [...new Set(found)];
}

function pickBlocks(unit) {
  const { key, tag } = unit;
  const re = new RegExp(`Big_${tag}\\.ino\\.cpp$`, 'm');
  const cc = fs.readFileSync(path.join(WORK, `cc1plus-${tag}.txt`), 'utf8');
  const cands = cc.split(/^=== cc1plus$/m).filter((b) => re.test(b));
  const score = (b) => b.split('\n').filter((l) => /\/(libraries|Arduino\/libraries)\/[^/]+(\/src)?$/.test(l)).length;
  const real = cands.filter((b) => !b.trim().split('\n').includes('-fsyntax-only'))
    .sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
  fs.writeFileSync(path.join(WORK, `big-${key}-cc1plus.txt`), real.replace(/^\n/, ''));

  const ld = fs.readFileSync(path.join(WORK, `ld-${tag}.txt`), 'utf8');
  const lb = ld.split(/^=== ld$/m).filter((b) => b.trim());
  const link = lb.find((b) => /\.ino\.elf$/m.test(b)) || lb[lb.length - 1];
  fs.writeFileSync(path.join(WORK, `big-${key}-ld.txt`), '=== ld\n' + link.replace(/^\n/, ''));
}

async function closure(unit, isys) {
  const distArm = process.env[`DIST_ESP_${unit.chip.toUpperCase()}`] || path.join(AVR, `dist-${unit.chip}-gcc`);
  const cc1plus = require(path.join(distArm, 'cc1plus.js'));
  const base = new Map();
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name); if (e.isDirectory()) walk(f);
    else base.set(f.slice(ESPROOT.length), fs.readFileSync(f)); } })(ESPROOT);
  let argv = fs.readFileSync(path.join(WORK, `big-${unit.key}-cc1plus.txt`), 'utf8').split('\n')
    .filter((l) => l !== '' && !l.startsWith('=== ') && !l.startsWith('--- @file') && !/cc1plus/.test(l));
  const oi = argv.indexOf('-o'); if (oi >= 0) argv[oi + 1] = '/work/s.s';
  argv = ['-quiet', '-H', ...isys.flatMap((d) => ['-isystem', d]), ...argv.filter((x) => x !== '-quiet')];
  const log = [];
  await cc1plus({ arguments: argv, print: (s) => log.push(s), printErr: (s) => log.push(s), quit: () => {},
    preRun: [(m) => { for (const [p, b] of base) { const i = p.lastIndexOf('/'); if (i > 0) m.FS.mkdirTree(p.slice(0, i)); m.FS.writeFile(p, b); } m.FS.mkdirTree('/work'); }] });
  const hdr = new Set();
  for (const l of log) { const mm = l.match(/^\.+\s+(\/.+)$/); if (mm) { const p = path.normalize(mm[1]); if (base.has(p)) hdr.add(p); } }
  fs.writeFileSync(path.join(WORK, `closure-big-${unit.key}.txt`), [...hdr].sort().join('\n'));
  return hdr.size;
}

(async () => {
  if (!process.env.SKIP_HARVEST) harvest();
  extract();
  // One -isystem list per gcc target (shared by that chip's boards).
  const isysByTarget = {};
  for (const u of UNITS) isysByTarget[u.gccTarget] ||= gincDirs(u.gccTarget);
  fs.writeFileSync(path.join(WORK, 'ginc.txt'), (isysByTarget[UNITS[0].gccTarget] || []).join('\n') + '\n');
  for (const u of UNITS) {
    pickBlocks(u);
    const n = await closure(u, isysByTarget[u.gccTarget]);
    console.log(`closure ${u.key}: ${n} headers`);
  }
  console.log('\n=== make-esp-dist ===');
  // Per-chip isystem differs; make-esp-dist reads ESP_ISYSTEM, so run it per chip.
  for (const t of bundlesForTrack('esp-v')) {
    const isys = isysByTarget[t.gccTarget] || [];
    const ginc = path.join(WORK, `ginc-${t.chip}.txt`);
    fs.writeFileSync(ginc, isys.join('\n') + '\n');
    execFileSync('node', [path.join(HERE, 'make-esp-dist.cjs'), t.chip], {
      stdio: 'inherit',
      env: { ...process.env, ESP_TMP: WORK, ESPROOT, ESP_ISYSTEM: ginc },
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
