// compiler.cjs — the JS "driver" that replaces avr-gcc + the arduino-cli
// builder.  It drives the decomposed WASM toolchain:
//
//     .ino/.cpp ──cc1plus──► .s ──avr-as──► .o ─┐
//     core/*.cpp ─────────────────────────────► ├─avr-ar─► core.a ─┐
//                                                │                  ├─avr-ld─► .elf ─objcopy─► .hex
//     sketch .o ─────────────────────────────────┘                 │
//                              libgcc.a + libc.a + crt<mcu>.o ──────┘
//
// avr-gcc on the desktop fork/exec's cc1plus, as and ld; we do that
// chaining here in JS instead, because Emscripten has no fork/exec.
//
// Runs in Node today (the .js tool modules load via require) and is written
// to be portable to a browser/WKWebView host: the only Node-isms are fs
// reads of the tool modules + sidecar, which a browser host supplies via
// fetch instead.
'use strict';

const fs = require('fs');
const path = require('path');
const R = require('./recipe.js');   // shared pure recipe logic (UMD)

// ── Tool module loading ────────────────────────────────────────────────
// Each tool is an Emscripten MODULARIZE factory. require() returns it
// regardless of EXPORT_NAME because MODULARIZE sets module.exports.
function loadFactory(distDir, name) {
  const p = path.resolve(distDir, name);   // require needs an absolute path
  if (!fs.existsSync(p)) throw new Error(`tool module missing: ${p}`);
  return require(p);
}

// Run one Emscripten tool. `inputs` is a Map<vfsPath, Uint8Array>, `outputs`
// is an array of vfs paths to read back. Resolves to Map<vfsPath, Uint8Array>
// or rejects with the captured stderr/stdout on non-zero exit.
async function runTool(factory, label, argv, inputs, outputs) {
  const log = [];
  let exitCode = 0;
  const out = new Map();
  await factory({
    arguments: argv,
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
    quit: (code) => { exitCode = code; },
    preRun: [(m) => {
      for (const [vfsPath, bytes] of inputs) {
        const slash = vfsPath.lastIndexOf('/');
        if (slash > 0) m.FS.mkdirTree(vfsPath.slice(0, slash));
        m.FS.writeFile(vfsPath, bytes);
      }
      // Ensure output directories exist (outputs aren't pre-written).
      for (const o of outputs) {
        const slash = o.lastIndexOf('/');
        if (slash > 0) m.FS.mkdirTree(o.slice(0, slash));
      }
    }],
    postRun: [(m) => {
      if (exitCode === 0) {
        for (const o of outputs) {
          try { out.set(o, m.FS.readFile(o)); }
          catch (e) { log.push(`cannot read ${o}: ${e.message}`); }
        }
      }
    }],
  });
  if (exitCode !== 0 || outputs.some((o) => !out.has(o))) {
    const err = new Error(`[${label}] failed (exit ${exitCode})\n${log.join('\n')}`);
    err.tool = label;
    err.log = log.join('\n');
    throw err;
  }
  return out;
}

class AvrToolchain {
  constructor(distDir, opts = {}) {
    this.distDir = distDir;
    this.sysroot = path.join(distDir, 'sysroot');
    this.lto = !!opts.lto;
    this.cc1plus = loadFactory(distDir, 'cc1plus.js');
    this.cc1 = loadFactory(distDir, 'cc1.js');
    this.as = loadFactory(distDir, 'avr-as.js');
    this.ld = loadFactory(distDir, 'avr-ld.js');
    this.ar = loadFactory(distDir, 'ar.js');
    this.objcopy = loadFactory(distDir, 'objcopy.js');
    this.lto1 = opts.lto ? loadFactory(distDir, 'lto1.js') : null;
    this._specCache = new Map();
  }

  // Merge slim LTO objects into one real-code object via lto1 + avr-as. The
  // single-partition lto1 pass does cross-module inlining/optimization; see
  // recipe.ltoArgv for why no -fresolution is needed. Non-LTO objects (e.g.
  // assembled .S) are returned unchanged for the caller to link alongside.
  async combineLto(board, ltoObjs) {
    const inputs = new Map();
    const names = ltoObjs.map((bytes, i) => { const n = `/work/l${i}.o`; inputs.set(n, bytes); return n; });
    inputs.set('/work/lto.opts', Buffer.from(names.join('\n') + '\n'));
    const argv = R.ltoArgv(board, this._spec('cc1', board.mcu), '/work/lto.opts', '/work/comb.s');
    const s = await runTool(this.lto1, 'lto1', argv, inputs, ['/work/comb.s']);
    const o = await runTool(this.as, 'as', ['-mmcu=' + board.mcu, '-o', '/work/comb.o', '/work/comb.s'],
      new Map([['/work/comb.s', s.get('/work/comb.s')]]), ['/work/comb.o']);
    return o.get('/work/comb.o');
  }

  _spec(lang, mcu) {
    const key = `${lang}-${mcu}`;
    if (!this._specCache.has(key))
      this._specCache.set(key, fs.readFileSync(path.join(this.distDir, 'specs', `${key}.txt`), 'utf8'));
    return this._specCache.get(key);
  }

  // Compile one translation unit to an object with the WASM toolchain.
  //  - .c/.cpp/.ino → cc1/cc1plus → .s → avr-as → .o
  //  - .S           → cc1 -E (preprocess) → .s → avr-as → .o
  async compileUnit(board, source, filename, includes) {
    const objVfs = '/work/unit.o';
    const asmVfs = '/work/unit.s';
    const incDirs = this._systemIncludes().concat(includes);
    // Mount the source's own directory too, so quoted includes (#include
    // "twi.h" next to twi.c) resolve, and place the source at its real VFS
    // path with -iquote on its directory (gcc's quoted-include search).
    const srcDir = path.dirname(path.resolve(filename));
    const inputs = this._mountTree(incDirs.concat([srcDir]));
    const quote = ['-iquote', srcDir];

    let asmBytes;
    if (R.isAsm(filename)) {
      // Assembler-with-cpp: run cc1 in preprocess-only mode, then assemble.
      const srcVfs = path.join(srcDir, path.basename(filename));
      inputs.set(srcVfs, Buffer.from(source));
      const incFlags = [];
      for (const d of incDirs) incFlags.push('-isystem', d);
      const ppArgv = ['-E', '-lang-asm', ...R.deviceFlags(this._spec('cc1', board.mcu)),
        ...R.defines(board), ...quote, ...incFlags, srcVfs, '-o', asmVfs];
      const pp = await runTool(this.cc1, 'cc1(-E)', ppArgv, inputs, [asmVfs]);
      asmBytes = pp.get(asmVfs);
    } else {
      const isCpp = R.isCpp(filename);
      const factory = isCpp ? this.cc1plus : this.cc1;
      const srcVfs = path.join(srcDir, path.basename(filename).replace(/\.ino$/, '.cpp'));
      inputs.set(srcVfs, Buffer.from(source));
      const argv = R.cc1Argv(board, this._spec(isCpp ? 'cc1plus' : 'cc1', board.mcu),
        incDirs, srcVfs, asmVfs, this.lto, quote);
      const s = await runTool(factory, isCpp ? 'cc1plus' : 'cc1', argv, inputs, [asmVfs]);
      asmBytes = s.get(asmVfs);
    }

    const asOut = await runTool(this.as, 'as',
      ['-mmcu=' + board.mcu, '-o', objVfs, asmVfs],
      new Map([[asmVfs, asmBytes]]), [objVfs]);
    return asOut.get(objVfs);
  }

  _systemIncludes() {
    return [
      path.join(this.sysroot, 'avr', 'include'),
      path.join(this.sysroot, 'gcc-include'),
    ];
  }
  _includeRoots() { return this._systemIncludes(); }

  // Read a set of host directories into a Map<vfsPath, bytes> rooted at the
  // same absolute paths (so -isystem flags resolve inside MEMFS).
  _mountTree(dirs) {
    const out = new Map();
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) out.set(full, fs.readFileSync(full));
      }
    };
    for (const d of dirs) if (fs.existsSync(d)) walk(d);
    return out;
  }

  // Archive a list of .o (Map name->bytes) into core.a with avr-ar.
  async archive(objects) {
    const inputs = new Map();
    const names = [];
    let i = 0;
    for (const [, bytes] of objects) {
      const n = `/work/obj${i++}.o`;
      inputs.set(n, bytes);
      names.push(n);
    }
    const out = await runTool(this.ar, 'ar',
      ['rcs', '/work/core.a', ...names], inputs, ['/work/core.a']);
    return out.get('/work/core.a');
  }

  // Link sketch objects + core.a + libgcc + libc into an ELF. Reproduces the
  // collect2/ld line the gcc driver generates for a non-LTO AVR build:
  //   ld -T <arch>.x -Tdata <addr> --gc-sections crt<mcu>.o <objs> core.a \
  //      -L<libgcc> -L<libc> --start-group -lgcc -lm -lc -l<mcu> --end-group
  // The device-specific -Tdata address and -l<mcu> come from the recorded
  // native driver link line (specs/link-<mcu>.txt).
  async link(board, sketchObjs, coreArchive) {
    const arch = board.arch;
    const mcu = board.mcu;
    const libcDir = `/usr/lib/avr/lib/${arch}`;        // avr-libc multilib
    const libgccDir = `/usr/lib/gcc/avr/${arch}`;      // libgcc multilib
    const scriptsDir = `/usr/lib/avr/lib/ldscripts`;
    const crt = board.crt;

    const tdata = R.linkTdata(this._readLinkSpec(mcu));
    const scriptVfs = `${scriptsDir}/${arch}.x`;

    const inputs = new Map();
    inputs.set(scriptVfs, this._sidecarFile(['avr', 'lib', 'ldscripts', `${arch}.x`]));
    inputs.set(`${libcDir}/${crt}`, this._sidecarFile(['avr', 'lib', arch, crt]));
    inputs.set(`${libcDir}/libc.a`, this._sidecarFile(['avr', 'lib', arch, 'libc.a']));
    inputs.set(`${libcDir}/libm.a`, this._sidecarFile(['avr', 'lib', arch, 'libm.a']));
    inputs.set(`${libcDir}/lib${mcu}.a`, this._sidecarFile(['avr', 'lib', arch, `lib${mcu}.a`]));
    inputs.set(`${libgccDir}/libgcc.a`, this._sidecarFile(['libgcc', arch, 'libgcc.a']));

    const objNames = [];
    let i = 0;
    for (const [, bytes] of sketchObjs) {
      const n = `/work/s${i++}.o`;
      inputs.set(n, bytes); objNames.push(n);
    }
    // core.a is optional: in LTO mode everything is merged into one object and
    // there is no separate core archive.
    let coreVfs = null;
    if (coreArchive) { coreVfs = '/work/core.a'; inputs.set(coreVfs, coreArchive); }

    const argv = R.linkArgv(board, {
      scriptVfs, tdata, crtVfs: `${libcDir}/${crt}`,
      objVfs: objNames, coreVfs,
      libgccDir, libcDir, outVfs: '/work/sketch.elf',
    });
    const out = await runTool(this.ld, 'ld', argv, inputs, ['/work/sketch.elf']);
    return out.get('/work/sketch.elf');
  }

  _readLinkSpec(mcu) {
    const p = path.join(this.distDir, 'specs', `link-${mcu}.txt`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  _sidecarFile(parts) {
    const p = path.join(this.sysroot, ...parts);
    if (!fs.existsSync(p)) throw new Error(`sidecar file missing: ${p}`);
    return fs.readFileSync(p);
  }

  async elf2hex(elfBytes) {
    const out = await runTool(this.objcopy, 'objcopy',
      ['-O', 'ihex', '-R', '.eeprom', '/work/sketch.elf', '/work/sketch.hex'],
      new Map([['/work/sketch.elf', elfBytes]]), ['/work/sketch.hex']);
    return Buffer.from(out.get('/work/sketch.hex')).toString('utf8');
  }
}

module.exports = { AvrToolchain, runTool };
