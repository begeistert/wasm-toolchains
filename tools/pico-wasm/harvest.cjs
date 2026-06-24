// harvest.cjs — host orchestrator for the Pico bundle. Drives the picocap
// container to capture, for each board, the exact cc1plus/ld invocations + the
// header closure + the precompiled link objects a native arduino-cli build
// produces, then builds the shippable multi-board bundle (make-pico-dist.cjs).
//
//   1. run tools/pico-wasm/harvest.sh in picocap for each board
//   2. tar the 3rd-party library sources (board-agnostic) once
//   3. extract everything into a /root mirror (PICOROOT)
//   4. pick the real cc1plus block (all libs) + the final ld block per board
//   5. compute the header closure (cc1plus -H) from the WASM toolchain
//   6. invoke make-pico-dist.cjs → dist-pico-web/
//
// Usage: node tools/pico-wasm/harvest.cjs [outDir]
//   env: PICOCAP_IMAGE (default picocap:latest), DIST_ARM (default ../../dist-arm-gcc),
//        WORK (scratch dir, default $TMPDIR/picoharvest)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const AVR = path.resolve(HERE, '..', '..');
const DIST_ARM = process.env.DIST_ARM || path.join(AVR, 'dist-arm-gcc');
const IMAGE = process.env.PICOCAP_IMAGE || 'picocap:latest';
const WORK = process.env.WORK || path.join(require('os').tmpdir(), 'picoharvest');
const PICOROOT = path.join(WORK, 'picoroot');
const OUT = process.argv[2] || path.join(AVR, 'dist-pico-web');

// board key -> { fqbn, tag }. The W variants share mcu/family with their sibling.
const BOARDS = {
  pico:   { fqbn: 'rpipico',   tag: 'pico' },
  pico2:  { fqbn: 'rpipico2',  tag: 'pico2' },
  pico_w: { fqbn: 'rpipicow',  tag: 'picow' },
  pico2w: { fqbn: 'rpipico2w', tag: 'pico2w' },
};

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const shOut = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

function dockerRun(extraArgs) {
  sh('docker', ['run', '--rm', '-v', `${WORK}:/out`, IMAGE, ...extraArgs]);
}

// ── 1+2. harvest each board + the shared library sources ────────────────────
function harvest() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'harvest.sh'), path.join(WORK, 'harvest.sh'));
  fs.copyFileSync(path.join(HERE, 'bigsketch.ino'), path.join(WORK, 'bigsketch.ino'));
  for (const { fqbn, tag } of Object.values(BOARDS)) {
    console.log(`\n=== harvest ${tag} (${fqbn}) ===`);
    dockerRun(['bash', '/out/harvest.sh', fqbn, tag]);
  }
  console.log('\n=== tar 3rd-party library sources ===');
  dockerRun(['bash', '-lc', 'tar cf /out/arduinolibs.tar /root/Arduino/libraries 2>/dev/null || true']);
}

// ── 3. mirror /root ─────────────────────────────────────────────────────────
function extract() {
  fs.rmSync(path.join(PICOROOT, 'root', '.cache', 'arduino', 'sketches'), { recursive: true, force: true });
  fs.mkdirSync(PICOROOT, { recursive: true });
  const untar = (f) => { if (fs.existsSync(f)) sh('tar', ['xf', f, '-C', PICOROOT]); };
  // The 5.6.0 hardware tree + pqt-gcc come from the first board's full cache; but
  // those live in the image, so tar them once too (headers + multilib + lib/rp2040|2350).
  dockerRun(['bash', '-lc',
    'tar cf /out/hwtc.tar /root/.arduino15/packages/rp2040/hardware/rp2040 /root/.arduino15/packages/rp2040/tools/pqt-gcc 2>/dev/null || true']);
  untar(path.join(WORK, 'hwtc.tar'));
  untar(path.join(WORK, 'arduinolibs.tar'));
  for (const { tag } of Object.values(BOARDS)) untar(path.join(WORK, `cacheb-${tag}.tar`));
}

// ── ginc: the toolchain C++/newlib/gcc -isystem dirs (build-fixed) ──────────
function gincDirs() {
  const tc = fs.readdirSync(path.join(PICOROOT, 'root/.arduino15/packages/rp2040/tools/pqt-gcc'))[0];
  const base = `/root/.arduino15/packages/rp2040/tools/pqt-gcc/${tc}`;
  const gv = '14.3.0';
  return [
    `${base}/arm-none-eabi/include/c++/${gv}`,
    `${base}/arm-none-eabi/include/c++/${gv}/arm-none-eabi/thumb`,
    `${base}/arm-none-eabi/include/c++/${gv}/backward`,
    `${base}/lib/gcc/arm-none-eabi/${gv}/include`,
    `${base}/lib/gcc/arm-none-eabi/${gv}/include-fixed`,
    `${base}/arm-none-eabi/include`,
  ];
}

// ── 4. pick the real cc1plus block (all libs) + final ld block ──────────────
function pickBlocks(key, tag) {
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

// ── 5. header closure via cc1plus -H ────────────────────────────────────────
async function closure(key, isys) {
  const cc1plus = require(path.join(DIST_ARM, 'cc1plus.js'));
  const base = new Map();
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name); if (e.isDirectory()) walk(f);
    else base.set(f.slice(PICOROOT.length), fs.readFileSync(f)); } })(PICOROOT);
  let argv = fs.readFileSync(path.join(WORK, `big-${key}-cc1plus.txt`), 'utf8').split('\n')
    .filter((l) => l !== '' && !l.startsWith('=== ') && !l.startsWith('--- @file') && !/cc1plus/.test(l));
  const oi = argv.indexOf('-o'); if (oi >= 0) argv[oi + 1] = '/work/s.s';
  argv = ['-quiet', '-H', ...isys.flatMap((d) => ['-isystem', d]), ...argv.filter((x) => x !== '-quiet')];
  const log = [];
  await cc1plus({ arguments: argv, print: (s) => log.push(s), printErr: (s) => log.push(s), quit: () => {},
    preRun: [(m) => { for (const [p, b] of base) { const i = p.lastIndexOf('/'); if (i > 0) m.FS.mkdirTree(p.slice(0, i)); m.FS.writeFile(p, b); } m.FS.mkdirTree('/work'); }] });
  const hdr = new Set();
  for (const l of log) { const mm = l.match(/^\.+\s+(\/.+)$/); if (mm) { const p = path.normalize(mm[1]); if (base.has(p)) hdr.add(p); } }
  fs.writeFileSync(path.join(WORK, `closure-big-${key}.txt`), [...hdr].sort().join('\n'));
  return hdr.size;
}

(async () => {
  if (!process.env.SKIP_HARVEST) harvest();
  extract();
  const isys = gincDirs();
  fs.writeFileSync(path.join(WORK, 'ginc.txt'), isys.join('\n') + '\n');
  for (const [key, { tag }] of Object.entries(BOARDS)) {
    pickBlocks(key, tag);
    const n = await closure(key, isys);
    fs.copyFileSync(path.join(WORK, `Big-${tag}-native.uf2`), path.join(WORK, `Big-${key}-native.uf2`));
    console.log(`closure ${key}: ${n} headers`);
  }
  console.log('\n=== make-pico-dist ===');
  execFileSync('node', [path.join(HERE, 'make-pico-dist.cjs'), OUT], {
    stdio: 'inherit',
    env: { ...process.env, PICO_TMP: WORK, PICOROOT, PICO_ISYSTEM: path.join(WORK, 'ginc.txt') },
  });
})().catch((e) => { console.error(e); process.exit(1); });
