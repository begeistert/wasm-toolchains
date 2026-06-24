// build-sketch.cjs — compile a real Arduino sketch (.ino) + optional libraries
// to Intel HEX using the decomposed WASM toolchain. This is the arduino-cli
// "compile" pipeline, reimplemented in JS (the agreed approach: reproduce the
// recipes, don't run the Go binary which can't fork/exec compilers on iOS).
'use strict';

const fs = require('fs');
const path = require('path');
const { AvrToolchain } = require('./compiler.cjs');
const R = require('./recipe.js');

const BOARDS = R.BOARDS;

// Gather a library's compilable sources + its include dir. Supports both the
// flat (sources in root) and 1.5 (sources under src/) Arduino library formats.
function gatherLibrary(libDir) {
  const srcDir = fs.existsSync(path.join(libDir, 'src')) ? path.join(libDir, 'src') : libDir;
  const recursive = srcDir.endsWith('src');
  const sources = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'examples' || e.name === 'extras' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive) walk(full); }
      else if (/\.(c|cpp|cc|cxx|S)$/.test(e.name)) sources.push(full);
    }
  };
  walk(srcDir);
  return { include: srcDir, sources };
}

async function buildSketch({ distDir, coreDir, board, sketchPath, libraries = [], lto = false }) {
  const b = typeof board === 'string' ? BOARDS[board] : board;
  if (!b) throw new Error(`unknown board: ${board}`);

  const tc = new AvrToolchain(distDir, { lto });
  const coreSrc = path.join(coreDir, 'cores', 'arduino');
  const variantDir = path.join(coreDir, 'variants', b.variant);

  // Library include dirs participate in every compile (core, libs, sketch).
  const libs = libraries.map(gatherLibrary);
  const libIncludes = libs.map((l) => l.include);
  const includes = [coreSrc, variantDir, ...libIncludes];

  const ltoObjs = [];        // slim LTO objects (merged by lto1 in LTO mode)
  const plainObjs = [];      // non-LTO objects (assembled .S, or all objs when !lto)
  const compile = async (file) => {
    process.stderr.write(`[cc] ${path.relative(process.cwd(), file)}\n`);
    const src = fs.readFileSync(file, 'utf8');
    const bytes = await tc.compileUnit(b, src, file, includes);
    (lto && !R.isAsm(file) ? ltoObjs : plainObjs).push(bytes);
  };

  // ── 1. Arduino core (.c/.cpp/.S) ──────────────────────────────────────
  for (const f of fs.readdirSync(coreSrc).filter((f) => /\.(c|cpp|S)$/.test(f)))
    await compile(path.join(coreSrc, f));

  // ── 2. Libraries ──────────────────────────────────────────────────────
  for (const lib of libs) for (const f of lib.sources) await compile(f);

  // ── 3. Sketch (.ino -> .cpp with prototype generation) ────────────────
  const cpp = R.preprocessIno(fs.readFileSync(sketchPath, 'utf8'));
  process.stderr.write(`[sketch] ${path.basename(sketchPath)}\n`);
  const sketchBytes = await tc.compileUnit(b, cpp, sketchPath, includes);
  (lto ? ltoObjs : plainObjs).push(sketchBytes);

  // ── 4. Combine/archive + link + objcopy ───────────────────────────────
  let objList = plainObjs, coreArchive = null;
  if (lto) {
    process.stderr.write(`[lto] merging ${ltoObjs.length} units via lto1\n`);
    objList = plainObjs.concat([await tc.combineLto(b, ltoObjs)]);
  } else {
    // non-LTO: archive core+libs, keep the sketch object out as the driver.
    coreArchive = await tc.archive(new Map(plainObjs.slice(0, -1).map((o, i) => [i, o])));
    objList = [plainObjs[plainObjs.length - 1]];
  }
  const elf = await tc.link(b, new Map(objList.map((o, i) => [i, o])), coreArchive);
  const hex = await tc.elf2hex(elf);
  return { hex, elf };
}

module.exports = { buildSketch, BOARDS };

// CLI: build-sketch.cjs <distDir> <coreDir> <board> <sketch.ino> [out.hex] [--lto] [--lib DIR]...
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const lto = argv.includes('--lto');
    const libraries = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--lib') libraries.push(argv[++i]);
    const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--lib');
    const [distDir, coreDir, board, sketchPath, outHex] = pos;
    if (!sketchPath) {
      console.error('usage: build-sketch.cjs <distDir> <coreDir> <board> <sketch.ino> [out.hex] [--lto] [--lib DIR]...');
      process.exit(2);
    }
    try {
      const { hex } = await buildSketch({ distDir, coreDir, board, sketchPath, libraries, lto });
      if (outHex) { fs.writeFileSync(outHex, hex); console.error(`wrote ${outHex}`); }
      else process.stdout.write(hex);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
