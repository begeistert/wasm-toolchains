// arduino-pipeline.js — browser/WKWebView orchestrator. iOS deployment twin of
// the Node harness (compiler.cjs/build-sketch.cjs); both share recipe.js and
// drive the SAME WASM modules. Only I/O differs (fetch here, fs in Node).
//
// window.compileArduino({ source, board, libraries }) -> { ok, hex, log }
//   libraries: optional array of library names present in manifest.libraries.
// Tool factories must be captured into window.__factories by index.html, and
// recipe.js loaded so window.ArduinoRecipe exists.
(function () {
  'use strict';
  const R = window.ArduinoRecipe;
  const BASE = './dist-web/';
  const log = (m) => { try { window.HybridWebView.SendRawMessage(`[arduino] ${m}`); } catch { console.log(m); } };
  const F = (n) => window.__factories[n];
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);

  // ── Lazy, cached fetching (keeps iOS memory in check) ─────────────────
  let MANIFEST = null;
  const cache = new Map();
  async function manifest() {
    if (!MANIFEST) MANIFEST = await (await fetch(BASE + 'manifest.json')).json();
    return MANIFEST;
  }
  async function fetchBytes(rel) {
    if (cache.has(rel)) return cache.get(rel);
    const r = await fetch(BASE + rel);
    if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    cache.set(rel, b);
    return b;
  }
  const fetchText = async (rel) => dec(await fetchBytes(rel));

  // VFS layout (mirrors what -isystem/-iquote expect inside MEMFS).
  const SYS_INC = '/sysroot/avr/include';
  const GCC_INC = '/sysroot/gcc-include';
  const distToVfs = (rel) => '/' + rel;     // dist-rel 'arduino-core/..' -> '/arduino-core/..'

  // ── Tool runner (same contract as compiler.cjs runTool) ───────────────
  async function runTool(factory, label, argv, inputs, outputs) {
    const lines = []; let exitCode = 0; const out = new Map();
    await factory({
      arguments: argv, print: (s) => lines.push(s), printErr: (s) => lines.push(s),
      quit: (c) => { exitCode = c; },
      preRun: [(m) => {
        for (const [p, b] of inputs) { const i = p.lastIndexOf('/'); if (i > 0) m.FS.mkdirTree(p.slice(0, i)); m.FS.writeFile(p, b); }
        for (const o of outputs) { const i = o.lastIndexOf('/'); if (i > 0) m.FS.mkdirTree(o.slice(0, i)); }
      }],
      postRun: [(m) => { if (exitCode === 0) for (const o of outputs) { try { out.set(o, m.FS.readFile(o)); } catch (e) { lines.push(`read ${o}: ${e.message}`); } } }],
    });
    if (exitCode !== 0 || outputs.some((o) => !out.has(o))) { const e = new Error(`[${label}] exit ${exitCode}\n${lines.join('\n')}`); e.tool = label; throw e; }
    return out;
  }

  // Build the MEMFS base map shared by every compile: headers + core/variant +
  // selected library trees, each mounted at its VFS path. Cached per board+libs.
  async function includeTree(b, libNames) {
    const m = await manifest();
    const inputs = new Map();
    const want = (rel) => /\.(h|hpp|inc|c|cpp|cc|cxx|S)$/.test(rel);
    const add = async (rel) => { inputs.set(distToVfs(rel), await fetchBytes(rel)); };
    for (const rel of m.sysroot) if (rel.startsWith('sysroot/avr/include') || rel.startsWith('sysroot/gcc-include')) await add(rel);
    for (const rel of m.core) if (want(rel) && (rel.includes('/cores/arduino/') || rel.includes(`/variants/${b.variant}/`))) await add(rel);
    for (const name of libNames) {
      const lib = m.libraries[name];
      if (!lib) throw new Error(`unknown library: ${name}`);
      for (const rel of lib.files) if (want(rel)) await add(rel);
    }
    return inputs;
  }

  function includeDirs(b, libNames, m) {
    const dirs = [SYS_INC, GCC_INC, '/arduino-core/cores/arduino', `/arduino-core/variants/${b.variant}`];
    for (const name of libNames) dirs.push('/' + m.libraries[name].include);
    return dirs;
  }

  // Compile one source (given by VFS path, content already in `base`) to .o.
  async function compileUnit(b, srcVfs, base, incDirs, spec, isAsm, lto) {
    const asmVfs = '/work/unit.s', objVfs = '/work/unit.o';
    const quote = ['-iquote', srcVfs.slice(0, srcVfs.lastIndexOf('/'))];
    const inputs = new Map(base);
    let argv;
    if (isAsm) {
      argv = ['-E', '-lang-asm', ...R.deviceFlags(spec), ...R.defines(b), ...quote,
        ...incDirs.flatMap((d) => ['-isystem', d]), srcVfs, '-o', asmVfs];
      await runTool(F('cc1'), 'cc1(-E)', argv, inputs, [asmVfs]).then((o) => inputs.set(asmVfs, o.get(asmVfs)));
    } else {
      const cpp = R.isCpp(srcVfs);
      argv = R.cc1Argv(b, spec, incDirs, srcVfs, asmVfs, lto, quote);
      const s = await runTool(cpp ? F('cc1plus') : F('cc1'), cpp ? 'cc1plus' : 'cc1', argv, inputs, [asmVfs]);
      inputs.set(asmVfs, s.get(asmVfs));
    }
    const o = await runTool(F('avr-as'), 'as', ['-mmcu=' + b.mcu, '-o', objVfs, asmVfs],
      new Map([[asmVfs, inputs.get(asmVfs)]]), [objVfs]);
    return o.get(objVfs);
  }

  // Merge slim LTO objects into one real-code object via lto1 + avr-as
  // (single-partition whole-program LTO; see recipe.ltoArgv).
  async function combineLto(b, ltoObjs, spec) {
    const inputs = new Map();
    const names = ltoObjs.map((bytes, i) => { const n = `/work/l${i}.o`; inputs.set(n, bytes); return n; });
    inputs.set('/work/lto.opts', enc(names.join('\n') + '\n'));
    const s = await runTool(F('lto1'), 'lto1', R.ltoArgv(b, spec, '/work/lto.opts', '/work/comb.s'),
      inputs, ['/work/comb.s']);
    const o = await runTool(F('avr-as'), 'as', ['-mmcu=' + b.mcu, '-o', '/work/comb.o', '/work/comb.s'],
      new Map([['/work/comb.s', s.get('/work/comb.s')]]), ['/work/comb.o']);
    return o.get('/work/comb.o');
  }

  async function link(b, sketchObjs, coreA) {
    const { arch, mcu, crt } = b;
    const libcDir = `/usr/lib/avr/lib/${arch}`, libgccDir = `/usr/lib/gcc/avr/${arch}`;
    const scriptVfs = `/usr/lib/avr/lib/ldscripts/${arch}.x`;
    const tdata = R.linkTdata(await fetchText(`specs/link-${mcu}.txt`));
    const inputs = new Map();
    inputs.set(scriptVfs, await fetchBytes(`sysroot/avr/lib/ldscripts/${arch}.x`));
    inputs.set(`${libcDir}/${crt}`, await fetchBytes(`sysroot/avr/lib/${arch}/${crt}`));
    inputs.set(`${libcDir}/libc.a`, await fetchBytes(`sysroot/avr/lib/${arch}/libc.a`));
    inputs.set(`${libcDir}/libm.a`, await fetchBytes(`sysroot/avr/lib/${arch}/libm.a`));
    inputs.set(`${libcDir}/lib${mcu}.a`, await fetchBytes(`sysroot/avr/lib/${arch}/lib${mcu}.a`));
    inputs.set(`${libgccDir}/libgcc.a`, await fetchBytes(`sysroot/libgcc/${arch}/libgcc.a`));
    const objNames = sketchObjs.map((bytes, i) => { const n = `/work/s${i}.o`; inputs.set(n, bytes); return n; });
    let coreVfs = null;                          // core.a is absent in LTO mode
    if (coreA) { coreVfs = '/work/core.a'; inputs.set(coreVfs, coreA); }
    const argv = R.linkArgv(b, { scriptVfs, tdata, crtVfs: `${libcDir}/${crt}`, objVfs: objNames,
      coreVfs, libgccDir, libcDir, outVfs: '/work/s.elf' });
    return (await runTool(F('avr-ld'), 'ld', argv, inputs, ['/work/s.elf'])).get('/work/s.elf');
  }

  window.compileArduino = async function (req) {
    try {
      const m = await manifest();
      const b = R.BOARDS[req.board] || R.BOARDS.uno;
      const libNames = req.libraries || [];
      const base = await includeTree(b, libNames);
      const incDirs = includeDirs(b, libNames, m);

      // Gather the compile units: core sources + library sources (.c/.cpp/.S).
      const units = [];
      for (const rel of m.core)
        if (/\/cores\/arduino\/.+\.(c|cpp|S)$/.test(rel)) units.push(distToVfs(rel));
      for (const name of libNames)
        for (const rel of m.libraries[name].files)
          if (/\.(c|cpp|cc|cxx|S)$/.test(rel)) units.push(distToVfs(rel));

      const lto = !!req.lto;
      log(`compiling ${units.length} core+lib units${lto ? ' (LTO)' : ''}…`);
      const ltoObjs = [], plainObjs = [];
      for (const u of units) {
        const spec = await fetchText(`specs/${R.isCpp(u) ? 'cc1plus' : 'cc1'}-${b.mcu}.txt`);
        const o = await compileUnit(b, u, base, incDirs, spec, R.isAsm(u), lto);
        (lto && !R.isAsm(u) ? ltoObjs : plainObjs).push(o);
      }

      log('compiling sketch…');
      const sketchVfs = '/sketch/sketch.cpp';
      const sketchBase = new Map(base);
      sketchBase.set(sketchVfs, enc(R.preprocessIno(req.source)));
      const spec = await fetchText(`specs/cc1plus-${b.mcu}.txt`);
      const sketchObj = await compileUnit(b, sketchVfs, sketchBase, incDirs, spec, false, lto);
      (lto ? ltoObjs : plainObjs).push(sketchObj);

      // Combine (LTO) or archive (non-LTO), then link.
      let objList = plainObjs, coreA = null;
      if (lto) {
        log(`merging ${ltoObjs.length} units via lto1…`);
        const ltoSpec = await fetchText(`specs/cc1-${b.mcu}.txt`);   // -m flags only
        objList = plainObjs.concat([await combineLto(b, ltoObjs, ltoSpec)]);
      } else {
        const arInputs = new Map();
        const names = plainObjs.slice(0, -1).map((bytes, i) => { const n = `/work/c${i}.o`; arInputs.set(n, bytes); return n; });
        coreA = (await runTool(F('ar'), 'ar', ['rcs', '/work/core.a', ...names], arInputs, ['/work/core.a'])).get('/work/core.a');
        objList = [plainObjs[plainObjs.length - 1]];
      }
      log('linking…');
      const elf = await link(b, objList, coreA);
      const hexBytes = (await runTool(F('objcopy'), 'objcopy', ['-O', 'ihex', '-R', '.eeprom', '/work/s.elf', '/work/s.hex'],
        new Map([['/work/s.elf', elf]]), ['/work/s.hex'])).get('/work/s.hex');
      log('done');
      return { ok: true, hex: dec(hexBytes), log: null };
    } catch (e) {
      log('ERROR ' + (e.message || e));
      return { ok: false, hex: null, log: e.message || String(e) };
    }
  };
})();
