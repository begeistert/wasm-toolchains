// make-pico-dist.cjs — assemble the iOS/WKWebView-shippable Pico on-device
// compiler bundle (RP2040 / Pico 1 + RP2350 / Pico 2), twin of
// arduino-wasm/make-web-dist.cjs.
//
// The arduino-pico core is *precompiled* (core.a + libpico/lwip/bearssl), so a
// per-sketch build only recompiles the sketch translation unit and relinks. The
// two boards share the ARM WASM tools AND the gcc `thumb` multilib (libc/libm/
// libgcc/libstdc++ — one soft-float multilib covers both M0+ and M33), so those
// ~75 MB ship ONCE; only the board-specific link inputs (lib/rp2040 vs
// lib/rp2350, core.a, boot2.o, memmap), header closure, argv templates, UF2
// family id and assembler cpu flags differ.
//
// Per board the bundle ships:
//   • the header closure cc1plus actually opened (cc1plus -H), NOT the 116 MB sdk
//   • the precompiled link inputs verbatim
//   • the captured cc1plus / ld argv templates
// Shared once: the tools and the C++ -isystem list.
//
// Inputs (per board) come from the harvest harness (see README): a cc1plus argv,
// an ld argv, a header closure list, and the extracted /root tree at PICOROOT.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AVR = path.resolve(__dirname, '..', '..');
const DIST_ARM = path.join(AVR, 'dist-arm-gcc');
const PICOROOT = process.env.PICOROOT || '/tmp/picoroot';
const TMP = process.env.PICO_TMP || '/tmp';
const OUT = process.argv[2] || path.join(AVR, 'dist-pico-web');
const ISYSTEM = process.env.PICO_ISYSTEM || path.join(TMP, 'ginc.txt');

// Per-board reference artifacts + target params. UF2 family is what the emulator
// (RP2350Machine.Uf2ToFlash) keys on: rp2040=0xe48bff56; rp2350 Arm-Secure data
// blocks=0xe48bff59 (the 0xe48bff57 "absolute" metadata block is skipped, so we
// don't emit it — only the .bin flash image must match).
// Reference build = a "kitchen-sink" sketch that #includes every Tier-1 library
// (SPI/Wire/EEPROM + NeoPixel/DHT/PWMServoDriver/BusIO/MCP9808/Unified Sensor/
// Keypad/Servo), so their headers land in the closure and their objects in the
// link. Any user sketch using a subset compiles + links (--gc-sections drops the
// unused). arduino-cli links 3rd-party libs as individual .cpp.o (not .a), which
// the link-input collector picks up the same way.
const armM0 = ['-mcpu=cortex-m0plus', '-mthumb'];
const armM33 = ['-mcpu=cortex-m33', '-mthumb', '-mfloat-abi=softfp', '-march=armv8-m.main+dsp+fp'];
const ref = (key) => ({
  cc1: path.join(TMP, `big-${key}-cc1plus.txt`), ld: path.join(TMP, `big-${key}-ld.txt`),
  closure: path.join(TMP, `closure-big-${key}.txt`),
});
const BOARDS = {
  pico:   { mcu: 'rp2040', family: 0xe48bff56, asFlags: armM0,  ...ref('pico') },
  pico2:  { mcu: 'rp2350', family: 0xe48bff59, asFlags: armM33, ...ref('pico2') },
  // Wireless variants (CYW43439): same mcu/family/cpu as the non-W sibling — the
  // WiFi/BT firmware comes in via the W core.a (the lib/rp2040|rp2350 archives are
  // the same files, shared via the vfs dedup).
  pico_w:  { mcu: 'rp2040', family: 0xe48bff56, asFlags: armM0,  ...ref('pico_w') },
  pico2w:  { mcu: 'rp2350', family: 0xe48bff59, asFlags: armM33, ...ref('pico2w') },
};

const rd = (f) => fs.readFileSync(f);
const rdRoot = (vfs) => rd(path.join(PICOROOT, vfs));
const argvLines = (file, execRe) => fs.readFileSync(file, 'utf8').split('\n')
  .filter((l) => l !== '' && !l.startsWith('=== ') && !l.startsWith('--- @file') && !execRe.test(l));
const norm = (p) => path.normalize(p);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function emit(rel, bytes) {
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, bytes);
  return rel;
}
// Files mounted into MEMFS keep their real /root/... path; stored under vfs/<path>
// and shared across boards (same path = same bytes = one copy).
const emitVfs = (vfsPath, bytes) => { const r = 'vfs' + vfsPath; if (!fs.existsSync(path.join(OUT, r))) emit(r, bytes); return r; };

const manifest = { tools: [], isystem: '', boards: {} };

// Shared tools, as [shippedName, sourceNameInDistArm]. Each .js loads its sidecar
// .wasm by the build-internal name (arm-as.js -> as-new.wasm, arm-ld.js ->
// ld-new.wasm), but src/arm-gcc/build.sh installs those .wasm renamed to
// arm-as.wasm / arm-ld.wasm. Ship them under the name the JS loader requests,
// sourcing from whichever name the build produced (fall back to the shipped name).
const TOOLS = [
  ['cc1plus.js', 'cc1plus.js'],  ['cc1plus.wasm', 'cc1plus.wasm'],
  ['arm-as.js', 'arm-as.js'],    ['as-new.wasm', 'arm-as.wasm'],
  ['arm-ld.js', 'arm-ld.js'],    ['ld-new.wasm', 'arm-ld.wasm'],
  ['objcopy.js', 'objcopy.js'],  ['objcopy.wasm', 'objcopy.wasm'],
];
for (const [shipped, srcName] of TOOLS) {
  let src = path.join(DIST_ARM, srcName);
  if (!fs.existsSync(src) && srcName !== shipped) src = path.join(DIST_ARM, shipped);
  if (!fs.existsSync(src))
    throw new Error(`make-pico-dist: missing tool ${shipped} (looked for ${srcName} in ${DIST_ARM})`);
  manifest.tools.push(emit(path.join('tools', shipped), rd(src)));
}
// Shared C++ -isystem list (toolchain-fixed, same multilib for both boards).
manifest.isystem = emit('templates/isystem.txt', rd(ISYSTEM));

function harvestBoard(name, cfg) {
  const b = { mcu: cfg.mcu, family: cfg.family, asFlags: cfg.asFlags, headers: [], link: [], templates: {} };

  // Header closure.
  for (const vfs of fs.readFileSync(cfg.closure, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
    b.headers.push(emitVfs(vfs, rdRoot(vfs)));

  // Link inputs: concrete paths in the ld argv + -l libs resolved against -L dirs.
  const ldRaw = argvLines(cfg.ld, /\/ld(\.real)?$/);
  const Ldirs = ldRaw.filter((a) => a.startsWith('-L')).map((a) => norm(a.slice(2)));
  const seen = new Set();
  const addLink = (vfs) => { if (!seen.has(vfs)) { seen.add(vfs); b.link.push(emitVfs(vfs, rdRoot(vfs))); } };
  for (let a of ldRaw) {
    if (a.startsWith('--script=')) a = a.slice('--script='.length);
    if (a.startsWith('/')) {
      const v = norm(a);
      if (/\.(a|o|ld)$/.test(v) && fs.existsSync(path.join(PICOROOT, v))) addLink(v);
    } else if (a.startsWith('-l')) {
      const lib = 'lib' + a.slice(2) + '.a';
      for (const d of Ldirs) { const c = norm(path.join(d, lib)); if (fs.existsSync(path.join(PICOROOT, c))) { addLink(c); break; } }
    }
  }

  // argv templates + the sketch source/object/elf paths the templates reference.
  b.templates.cc1plus = emit(`templates/${name}/cc1plus.argv`, Buffer.from(argvLines(cfg.cc1, /cc1plus/).join('\n')));
  b.templates.ld = emit(`templates/${name}/ld.argv`, Buffer.from(ldRaw.join('\n')));
  b.sketchSrc = norm(argvLines(cfg.cc1, /cc1plus/).find((l) => /\.ino\.cpp$/.test(l)));
  b.sketchObj = norm(ldRaw.find((l) => /\.ino\.cpp\.o$/.test(l)));
  b.outElf = norm(ldRaw[ldRaw.indexOf('-o') + 1]);
  manifest.boards[name] = b;
  return b;
}

const targets = (process.env.PICO_BOARDS || 'pico,pico2').split(',');
for (const name of targets) if (BOARDS[name]) harvestBoard(name, BOARDS[name]);

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Size report (ships RAW — the custom WKURLScheme handler doesn't inflate; we
// only measure brotli potential).
let raw = 0, br = 0;
const all = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name); e.isDirectory() ? walk(f) : all.push(f); } })(OUT);
for (const f of all) {
  const sz = fs.statSync(f).size; raw += sz;
  br += (/\.(wasm|js|a)$/.test(f) && sz > 65536)
    ? zlib.brotliCompressSync(rd(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length : sz;
}
const bl = Object.entries(manifest.boards).map(([n, b]) => `${n}:${b.headers.length}h/${b.link.length}l`).join(' ');
console.log(`pico dist ready: ${manifest.tools.length} tools, boards [${bl}] — ` +
  `${(raw / 1048576).toFixed(1)} MB raw shipped (${(br / 1048576).toFixed(1)} MB if brotli'd).`);
