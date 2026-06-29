// make-esp-dist.cjs — assemble the shippable ESP32 on-device compiler bundles,
// twin of pico-wasm/make-pico-dist.cjs. Builds one bundle per esp chip on the
// `esp-v` track (esp32 = Xtensa, esp32c3 = RISC-V). Unlike the pico W overlay,
// the two esp bundles share NOTHING — each is a different ISA, so each ships its
// own cc1plus.wasm + binutils. The arduino-esp32 core is precompiled, so a
// per-sketch build only recompiles the sketch TU and relinks against the harvested
// core.a + libs; harvest captures the cc1plus/ld argv, header closure and link
// inputs exactly as the pico path does.
//
// ESP output is a flash IMAGE (esptool: bootloader + partition table + app), not a
// single .uf2/.hex — so the manifest records the per-chip flash offsets the
// host/emulator uses to place the harvested app .bin. objcopy still produces the
// app .bin from the .elf; the offsets live in the registry (targets/esp32*.json).
//
// Inputs (per board) come from the harvest harness (tools/esp-wasm/harvest.cjs):
// a cc1plus argv, an ld argv, a header closure list, and the extracted /root tree.
// Per-bundle ARM-style tool dir: dist-<chip>-gcc (or DIST_ESP_<CHIP> / argv[3]).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { bundlesForTrack } = require('../targets/registry.cjs');

const AVR = path.resolve(__dirname, '..', '..');
const PICOROOT = process.env.ESPROOT || process.env.PICOROOT || '/tmp/esproot';
const TMP = process.env.ESP_TMP || '/tmp';
const ISYSTEM = process.env.ESP_ISYSTEM || path.join(TMP, 'ginc.txt');

const rd = (f) => fs.readFileSync(f);
const rdRoot = (vfs) => rd(path.join(PICOROOT, vfs));
const argvLines = (file, execRe) => fs.readFileSync(file, 'utf8').split('\n')
  .filter((l) => l !== '' && !l.startsWith('=== ') && !l.startsWith('--- @file') && !execRe.test(l));
const norm = (p) => path.normalize(p);
const ref = (key) => ({
  cc1: path.join(TMP, `big-${key}-cc1plus.txt`), ld: path.join(TMP, `big-${key}-ld.txt`),
  closure: path.join(TMP, `closure-big-${key}.txt`),
});

// Tool dir + names for one chip. as/ld are named after the binutils target prefix
// (riscv32-as, xtensa-as); the .js loaders reference the build-internal as-new.wasm
// / ld-new.wasm, shipped under those names sourced from the renamed sidecars (same
// trick as make-pico-dist).
function toolPlan(t) {
  const distArm = process.env[`DIST_ESP_${t.chip.toUpperCase()}`] ||
    path.join(AVR, `dist-${t.chip}-gcc`);
  const as = t.gccTarget.replace('-esp-elf', '');     // riscv32 | xtensa
  const tools = [
    ['cc1plus.js', 'cc1plus.js'],     ['cc1plus.wasm', 'cc1plus.wasm'],
    [`${as}-as.js`, `${as}-as.js`],   ['as-new.wasm', `${as}-as.wasm`],
    [`${as}-ld.js`, `${as}-ld.js`],   ['ld-new.wasm', `${as}-ld.wasm`],
    ['objcopy.js', 'objcopy.js'],     ['objcopy.wasm', 'objcopy.wasm'],
  ];
  return { distArm, tools, as };
}

function buildBundle(t) {
  // Each chip's bundle lands in its own dist dir. ESP_OUT_BASE relocates the lot
  // (the fixture points it at a scratch dir so nothing touches the repo root).
  const outDir = path.join(process.env.ESP_OUT_BASE || AVR, t.distDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const emit = (rel, bytes) => {
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes); return rel;
  };
  const emitVfs = (vfsPath, bytes) => { const r = 'vfs' + vfsPath; if (!fs.existsSync(path.join(outDir, r))) emit(r, bytes); return r; };

  const { distArm, tools } = toolPlan(t);
  const manifest = { chip: t.chip, arch: t.arch, output: t.output, flash: t.flash, tools: [], isystem: '', boards: {} };

  for (const [ship, srcName] of tools) {
    let src = path.join(distArm, srcName);
    if (!fs.existsSync(src) && srcName !== ship) src = path.join(distArm, ship);
    if (!fs.existsSync(src)) throw new Error(`make-esp-dist[${t.chip}]: missing tool ${ship} (looked for ${srcName} in ${distArm})`);
    manifest.tools.push(emit(path.join('tools', ship), rd(src)));
  }
  manifest.isystem = emit('templates/isystem.txt', rd(ISYSTEM));

  for (const board of t.boards) {
    const cfg = ref(board.key);
    const b = { mcu: board.mcu, asFlags: board.asFlags, headers: [], link: [], templates: {} };
    for (const vfs of fs.readFileSync(cfg.closure, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
      b.headers.push(emitVfs(vfs, rdRoot(vfs)));

    const ldRaw = argvLines(cfg.ld, /\/ld(\.real)?$/);
    const Ldirs = ldRaw.filter((a) => a.startsWith('-L')).map((a) => norm(a.slice(2)));
    const seen = new Set();
    const addLink = (vfs) => { if (!seen.has(vfs)) { seen.add(vfs); b.link.push(emitVfs(vfs, rdRoot(vfs))); } };
    for (let a of ldRaw) {
      if (a.startsWith('--script=')) a = a.slice('--script='.length);
      if (a.startsWith('/')) { const v = norm(a); if (/\.(a|o|ld)$/.test(v) && fs.existsSync(path.join(PICOROOT, v))) addLink(v); }
      else if (a.startsWith('-l')) { const lib = 'lib' + a.slice(2) + '.a'; for (const d of Ldirs) { const c = norm(path.join(d, lib)); if (fs.existsSync(path.join(PICOROOT, c))) { addLink(c); break; } } }
    }

    // ESP linker scripts: arduino-esp32 passes them as `-T <bare-name>` resolved
    // from the chip's SDK ld dir (esp32-arduino-libs/<ver>/<chip>/ld), which isn't
    // in the captured -L set, so the bare names wouldn't resolve on the host. Ship
    // that dir's .ld scripts and prepend it as a -L (INCLUDE-safe: any script the
    // memory/sections .ld pull in is found there too).
    const sdkLd = (() => {
      const base = path.join(PICOROOT, 'root/.arduino15/packages/esp32/tools/esp32-arduino-libs');
      if (!fs.existsSync(base)) return null;
      for (const ver of fs.readdirSync(base)) { const d = path.join(base, ver, t.chip, 'ld'); if (fs.existsSync(d)) return d; }
      return null;
    })();
    if (sdkLd) {
      const vfsLd = '/' + path.relative(PICOROOT, sdkLd);
      // .ld scripts AND the SDK .a libs that live alongside them (libphy/librtc/
      // libbtdm_app... referenced by -l but not in any captured -L dir).
      for (const f of fs.readdirSync(sdkLd)) if (/\.(ld|a)$/.test(f)) addLink(norm(path.join(vfsLd, f)));
      ldRaw.unshift('-L' + vfsLd);
    }
    // Make the ld argv self-contained for a wasm host. The captured argv carries a
    // --sysroot that breaks wasm-ld's -L search in MEMFS (so bare `-T <script>` and
    // `-l<lib>` don't resolve) and un-normalized `bin/../lib/...` paths MEMFS can't
    // walk. So: normalize every path, and rewrite `-T <name>` / `-l<name>` to the
    // absolute path of the shipped link input. Also strip the dynconfig options
    // (cc1plus -mdynconfig / ld --dynconfig select the plugin path the static
    // per-chip toolchain rejects).
    // -fno-use-cxa-atexit: global C++ objects' dtor registration otherwise emits
    // __cxa_atexit(dtor, obj, &__dso_handle), but no esp link input defines
    // __dso_handle — so a user sketch with a global object (e.g. `WiFiClient c;`)
    // wouldn't link. Registering via atexit instead avoids the reference (same fix
    // recipe-pico applies host-side). The precompiled core/IDF libs are already
    // built this way, so only the freshly-compiled sketch needs it.
    const cc1Argv = ['-fno-use-cxa-atexit', ...argvLines(cfg.cc1, /cc1plus/).filter((l) => !/^-mdynconfig/.test(l))];
    const byName = new Map(b.link.map((r) => [path.basename(r), r.replace(/^vfs/, '')]));
    const ldArgv = ldRaw.filter((l) => !/^--?dynconfig/.test(l))
      .map((a) => a.startsWith('-L') ? '-L' + norm(a.slice(2)) : (a.startsWith('/') ? norm(a) : a));
    for (let i = 0; i < ldArgv.length; i++) {
      if (ldArgv[i] === '-T' && byName.has(ldArgv[i + 1])) ldArgv[i + 1] = byName.get(ldArgv[i + 1]);
      const lm = ldArgv[i].match(/^-l(.+)$/);
      if (lm && byName.has('lib' + lm[1] + '.a')) ldArgv[i] = byName.get('lib' + lm[1] + '.a');
    }

    b.templates.cc1plus = emit(`templates/${board.key}/cc1plus.argv`, Buffer.from(cc1Argv.join('\n')));
    b.templates.ld = emit(`templates/${board.key}/ld.argv`, Buffer.from(ldArgv.join('\n')));
    b.sketchSrc = norm(cc1Argv.find((l) => /\.ino\.cpp$/.test(l)));
    b.sketchObj = norm(ldArgv.find((l) => /\.ino\.cpp\.o$/.test(l)));
    b.outElf = norm(ldRaw[ldRaw.indexOf('-o') + 1]);
    manifest.boards[board.key] = b;
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  report(t.id, outDir, manifest);
}

function report(id, outDir, manifest) {
  let raw = 0, br = 0;
  const all = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name); e.isDirectory() ? walk(f) : all.push(f); } })(outDir);
  for (const f of all) {
    const sz = fs.statSync(f).size; raw += sz;
    br += (/\.(wasm|js|a)$/.test(f) && sz > 65536)
      ? zlib.brotliCompressSync(rd(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length : sz;
  }
  const bl = Object.entries(manifest.boards).map(([n, b]) => `${n}:${b.headers.length}h/${b.link.length}l`).join(' ');
  console.log(`${id} ready: ${manifest.tools.length} tools, app@${manifest.flash.app}, boards [${bl}] — ` +
    `${(raw / 1048576).toFixed(1)} MB raw (${(br / 1048576).toFixed(1)} MB if brotli'd).`);
}

// Build every esp bundle, or just the one named by argv[2] (chip id or chip key,
// e.g. `esp32c3-toolchain` or `esp32c3`) so CI can build per-arch in parallel.
const only = process.argv[2];
for (const t of bundlesForTrack('esp-v')) {
  if (only && only !== t.id && only !== t.chip) continue;
  buildBundle(t);
}
