// verify-pico.cjs — Node twin of the browser pico pipeline. Drives the SHIPPED
// multi-board bundle (dist-pico-web) through recipe-pico.js with the real ARM
// WASM tools, then checks the produced firmware against the native arduino-cli
// reference. For rp2040 the .uf2 is byte-identical; for rp2350 the native .uf2
// carries an extra 0xe48bff57 metadata block, so we instead verify the *flash
// image* the emulator extracts (Uf2ToFlash mirror) is identical — that is the
// real correctness criterion. fetch -> fs is the only difference vs the browser.
'use strict';
const fs = require('fs');
const path = require('path');

// The shipped bundle to verify. Defaults to the repo's dist-pico-web; a host app
// embedding a copy can point here via argv or the DIST env var. Resolve to an
// absolute path so the require()s below work regardless of cwd (require treats a
// bare relative path as a module name, not a file).
const DIST = path.resolve(process.argv[2] || process.env.DIST || path.join(__dirname, '../../dist-pico-web'));
// recipe-pico.js is canonical here (the toolchain repo); a host app that ships a
// copy alongside its bundle should keep them in sync. Override with RECIPE if needed.
const R = require(process.env.RECIPE || path.join(__dirname, 'recipe-pico.js'));
// Reference build artifacts live in the harvest work dir (see harvest.cjs).
const WORK = process.env.WORK || path.join(require('os').tmpdir(), 'picoharvest');
const PICOROOT = process.env.PICOROOT || path.join(WORK, 'picoroot');
const REFS = {
  pico: path.join(WORK, 'Big-pico-native.uf2'), pico2: path.join(WORK, 'Big-pico2-native.uf2'),
  pico_w: path.join(WORK, 'Big-picow-native.uf2'), pico2w: path.join(WORK, 'Big-pico2w-native.uf2'),
};

const F = {
  cc1plus: require(path.join(DIST, 'tools/cc1plus.js')),
  'arm-as': require(path.join(DIST, 'tools/arm-as.js')),
  'arm-ld': require(path.join(DIST, 'tools/arm-ld.js')),
  objcopy: require(path.join(DIST, 'tools/objcopy.js')),
};
const enc = (s) => new TextEncoder().encode(s);
const m = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const rdBundle = (rel) => fs.readFileSync(path.join(DIST, rel));
const tpl = (p) => fs.readFileSync(path.join(DIST, p.replace(/^.*?templates\//, 'templates/')), 'utf8');

async function runTool(factory, label, argv, inputs, outputs) {
  const lines = []; let ec = 0; const out = new Map();
  await factory({
    arguments: argv, print: (s) => lines.push(s), printErr: (s) => lines.push(s), quit: (c) => { ec = c; },
    preRun: [(M) => {
      for (const [p, b] of inputs) { const i = p.lastIndexOf('/'); if (i > 0) M.FS.mkdirTree(p.slice(0, i)); M.FS.writeFile(p, b); }
      for (const o of outputs) { const i = o.lastIndexOf('/'); if (i > 0) M.FS.mkdirTree(o.slice(0, i)); }
    }],
    postRun: [(M) => { if (ec === 0) for (const o of outputs) { try { out.set(o, M.FS.readFile(o)); } catch (e) { lines.push('read ' + o + ': ' + e.message); } } }],
  });
  if (ec !== 0 || outputs.some((o) => !out.has(o))) throw new Error(`[${label}] exit ${ec}\n${lines.slice(-12).join('\n')}`);
  return out;
}

function baseFs(bcfg) {
  const inputs = new Map();
  for (const rel of bcfg.headers) inputs.set(rel.replace(/^vfs/, ''), rdBundle(rel));
  for (const rel of bcfg.link) inputs.set(rel.replace(/^vfs/, ''), rdBundle(rel));
  return inputs;
}

async function compile(board, source, preprocessed) {
  const bcfg = m.boards[board];
  const cc1tpl = tpl(bcfg.templates.cc1plus).split('\n').filter(Boolean);
  const ldtpl = tpl(bcfg.templates.ld).split('\n').filter((l) => l !== '');
  const isys = tpl(m.isystem).trim().split('\n').filter(Boolean);
  const base = baseFs(bcfg);
  base.set(bcfg.sketchSrc, enc(preprocessed ? source : R.preprocessIno(source)));
  const sVfs = '/work/sketch.s';
  const cc1 = await runTool(F.cc1plus, 'cc1plus', R.cc1Argv(cc1tpl, isys, sVfs), base, [sVfs]);
  const asOut = await runTool(F['arm-as'], 'arm-as', R.asArgv(bcfg.asFlags, bcfg.sketchObj, sVfs), new Map([[sVfs, cc1.get(sVfs)]]), [bcfg.sketchObj]);
  const elfVfs = '/work/sketch.elf';
  const linkIn = base; linkIn.set(bcfg.sketchObj, asOut.get(bcfg.sketchObj));
  const elf = (await runTool(F['arm-ld'], 'arm-ld', R.ldArgv(ldtpl, elfVfs), linkIn, [elfVfs])).get(elfVfs);
  const bin = Buffer.from((await runTool(F.objcopy, 'objcopy', ['-O', 'binary', elfVfs, '/work/s.bin'], new Map([[elfVfs, elf]]), ['/work/s.bin'])).get('/work/s.bin'));
  return { uf2: Buffer.from(R.binToUf2(bin, bcfg.family)), bin };
}

// Mirror of RP2040/RP2350 Machine.Uf2ToFlash: skip not-main-flash + the
// absolute(0xe48bff57)/data(0xe48bff58) families, copy the rest at addr-0x10000000.
function uf2ToFlash(uf2) {
  const FLASH = 0x10000000, ABS = 0xe48bff57, DATA = 0xe48bff58;
  let min = 0xffffffff, max = 0;
  const blocks = [];
  for (let o = 0; o + 512 <= uf2.length; o += 512) {
    const flags = uf2.readUInt32LE(o + 8), addr = uf2.readUInt32LE(o + 12);
    const psz = uf2.readUInt32LE(o + 16), fam = uf2.readUInt32LE(o + 28);
    if (flags & 1) continue;
    if ((flags & 0x2000) && (fam === ABS || fam === DATA)) continue;
    blocks.push({ addr, psz, o });
    if (addr < min) min = addr;
    if (addr + psz > max) max = addr + psz;
  }
  const img = Buffer.alloc(max - FLASH, 0xff);
  for (const b of blocks) uf2.copy(img, b.addr - FLASH, b.o + 32, b.o + 32 + b.psz);
  return img;
}

(async () => {
  let allOk = true;
  for (const board of Object.keys(m.boards)) {
    const bcfg = m.boards[board];
    const nativeCpp = fs.readFileSync(path.join(PICOROOT, bcfg.sketchSrc)).toString();
    const { uf2, bin } = await compile(board, nativeCpp, true);
    const ref = fs.readFileSync(REFS[board]);

    const myFlash = uf2ToFlash(uf2), refFlash = uf2ToFlash(ref);
    const flashOk = Buffer.compare(myFlash, refFlash) === 0;
    const byteId = Buffer.compare(uf2, ref) === 0;
    allOk = allOk && flashOk;
    console.log(`[${board}] mcu=${bcfg.mcu} family=0x${bcfg.family.toString(16)} | ` +
      `bin ${bin.length} B, my uf2 ${uf2.length} B, native ${ref.length} B | ` +
      `flash-image ${flashOk ? 'IDENTICAL ✓' : 'DIFFERS ✗'}` + (byteId ? ' (uf2 byte-identical too)' : ''));

    // ino->cpp Tier-1 path: an in-app sketch using the BUNDLED third-party libs
    // (NeoPixel + DHT + Servo) must compile AND link against their shipped objects.
    const lib = '#include <Adafruit_NeoPixel.h>\n#include <DHT.h>\n#include <Servo.h>\n' +
      'Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);\n DHT dht(7, DHT22);\n Servo servo;\n' +
      'void setup(){ strip.begin(); dht.begin(); servo.attach(9); }\n' +
      'void loop(){ strip.setPixelColor(0, strip.Color(1,2,3)); strip.show(); servo.write((int)dht.readTemperature()%180); }\n';
    const lb = await compile(board, lib, false);
    console.log(`[${board}] ino->cpp NeoPixel+DHT+Servo compiled+linked on-device: ${lb.uf2.length} B uf2 ✓`);
  }
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('FAIL\n' + (e.message || e)); process.exit(1); });
