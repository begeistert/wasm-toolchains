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

// Flatten the track into per-board harvest units. nativeTarget is the triple
// arduino-esp32 ships (what we WRAP to capture the native build — e.g. the unified
// xtensa-esp-elf); gccTarget is the per-chip static triple we BUILT and ship (e.g.
// xtensa-esp32-elf). They differ only for Xtensa.
const UNITS = bundlesForTrack('esp-v').flatMap((t) =>
  t.boards.map((b) => ({ chip: t.chip, gccTarget: t.gccTarget, nativeTarget: t.nativeTarget || t.gccTarget, ...b })));

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const dockerRun = (extra) => sh('docker', ['run', '--rm', '-v', `${WORK}:/out`, IMAGE, ...extra]);

function harvest() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'harvest.sh'), path.join(WORK, 'harvest.sh'));
  // ESP-specific kitchen-sink (the pico one #includes Servo, which arduino-esp32
  // has no library for). See tools/esp-wasm/bigsketch.ino.
  fs.copyFileSync(path.join(HERE, 'bigsketch.ino'), path.join(WORK, 'bigsketch.ino'));
  for (const u of UNITS) {
    console.log(`\n=== harvest ${u.tag} (${u.fqbn}, native ${u.nativeTarget}) ===`);
    dockerRun(['bash', '/out/harvest.sh', u.fqbn, u.tag, u.nativeTarget]);
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

// The C/C++ -isystem search path for one board, derived from the gcc MULTILIB path
// the native link used (e.g. .../lib/gcc/<tgt>/<ver>/esp32/no-rtti). This pins the
// versioned c++ headers (<algorithm> etc.) AND the matching c++config.h multilib —
// our wasm cc1plus's built-in path points at the build prefix, so without these the
// closure (cc1plus -H) fatals at `#include <algorithm>` and captures a partial set.
function cxxIncludeDirs(unit) {
  const tgt = unit.nativeTarget;
  const ld = fs.readFileSync(path.join(WORK, `big-${unit.key}-ld.txt`), 'utf8').split('\n');
  const re = new RegExp(`^(.*)/lib/gcc/${tgt}/([^/]+)/(.+)$`);
  let tcRoot, ver, multilib;
  for (const l of ld) {
    if (!l.startsWith('-L')) continue;
    const mm = path.normalize(l.slice(2)).match(re);   // normalize removes bin/../lib
    if (mm) { [, tcRoot, ver, multilib] = mm; break; }
  }
  if (!tcRoot) return [];
  const cxx = `${tcRoot}/${tgt}/include/c++/${ver}`;
  const gl = `${tcRoot}/lib/gcc/${tgt}/${ver}`;
  return [cxx, `${cxx}/${tgt}/${multilib}`, `${cxx}/backward`, `${gl}/include`, `${gl}/include-fixed`, `${tcRoot}/${tgt}/include`]
    .filter((d) => fs.existsSync(path.join(ESPROOT, d)));
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
  delete process.env.XTENSA_GNU_CONFIG;   // our static cc1plus must not look for the dynconfig plugin
  let argv = fs.readFileSync(path.join(WORK, `big-${unit.key}-cc1plus.txt`), 'utf8').split('\n')
    .filter((l) => l !== '' && !l.startsWith('=== ') && !l.startsWith('--- @file') && !/cc1plus/.test(l))
    .filter((l) => !/^-mdynconfig/.test(l));   // unified-toolchain flag our per-chip static gcc rejects
  const oi = argv.indexOf('-o'); if (oi >= 0) argv[oi + 1] = '/work/s.s';
  argv = ['-quiet', '-H', ...isys.flatMap((d) => ['-isystem', d]), ...argv.filter((x) => x !== '-quiet')];
  const log = [];
  await cc1plus({ arguments: argv, print: (s) => log.push(s), printErr: (s) => log.push(s), quit: () => {},
    preRun: [(m) => { for (const [p, b] of base) { const i = p.lastIndexOf('/'); if (i > 0) m.FS.mkdirTree(p.slice(0, i)); m.FS.writeFile(p, b); } m.FS.mkdirTree('/work'); }] });
  process.exitCode = 0;   // don't let the Emscripten module's lingering exit code fail the run; we decide below
  const hdr = new Set();
  for (const l of log) { const mm = l.match(/^\.+\s+(\/.+)$/); if (mm) { const p = path.normalize(mm[1]); if (base.has(p)) hdr.add(p); } }
  fs.writeFileSync(path.join(WORK, `closure-big-${unit.key}.txt`), [...hdr].sort().join('\n'));
  return { n: hdr.size, log, isys };
}

(async () => {
  if (!process.env.SKIP_HARVEST) harvest();
  extract();
  // -isystem is per board (the multilib differs); derived after pickBlocks from the
  // captured ld argv. Closures with a near-empty result mean the c++ path is wrong.
  const isysByChip = {};
  let empty = 0;
  for (const u of UNITS) {
    pickBlocks(u);
    const isys = cxxIncludeDirs(u);
    isysByChip[u.chip] = isys;
    const { n, log } = await closure(u, isys);
    console.log(`closure ${u.key}: ${n} headers (${isys.length} -isystem dirs)`);
    if (n < 20) {
      empty++;
      console.error(`\n!!! closure ${u.key} too small (${n}) — diagnostics:`);
      console.error(`  isystem dirs (${isys.length}):\n` + isys.map((d) => '    ' + d).join('\n'));
      console.error(`  cc1plus -H output (last 30 lines):\n` + log.slice(-30).map((l) => '    ' + l).join('\n'));
    }
  }
  if (empty) { console.error(`\n${empty} board(s) produced a too-small header closure — fix cxxIncludeDirs/argv before bundling.`); process.exit(1); }
  console.log('\n=== make-esp-dist ===');
  // Per-chip isystem differs; make-esp-dist reads ESP_ISYSTEM, so run it per chip.
  for (const t of bundlesForTrack('esp-v')) {
    const isys = isysByChip[t.chip] || [];
    const ginc = path.join(WORK, `ginc-${t.chip}.txt`);
    fs.writeFileSync(ginc, isys.join('\n') + '\n');
    execFileSync('node', [path.join(HERE, 'make-esp-dist.cjs'), t.chip], {
      stdio: 'inherit',
      env: { ...process.env, ESP_TMP: WORK, ESPROOT, ESP_ISYSTEM: ginc },
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
