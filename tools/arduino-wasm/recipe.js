// recipe.js — pure, host-agnostic Arduino-build logic shared by the Node test
// harness (compiler.cjs/build-sketch.cjs) and the browser/WKWebView
// orchestrator (examples/arduino-web/arduino-pipeline.js). No I/O here: just
// board data, flag sets, the .ino->.cpp transform (with ctags-style prototype
// generation), and argv builders. UMD so both `require` and a <script> tag work.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArduinoRecipe = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOARDS = {
    uno:  { mcu: 'atmega328p', arch: 'avr5', crt: 'crtatmega328p.o', fcpu: '16000000L', board: 'AVR_UNO',      variant: 'standard' },
    nano: { mcu: 'atmega328p', arch: 'avr5', crt: 'crtatmega328p.o', fcpu: '16000000L', board: 'AVR_NANO',     variant: 'standard' },
    mega: { mcu: 'atmega2560', arch: 'avr6', crt: 'crtatmega2560.o', fcpu: '16000000L', board: 'AVR_MEGA2560', variant: 'mega' },
  };
  const ARDUINO_VERSION = '10607';

  // LTO is opt-in: when enabled we add -flto so cc1 emits GIMPLE and the link
  // step runs lto1 (see compiler.cjs). Off by default for the simple path.
  function cppFlags(lto) {
    const f = ['-Os', '-std=gnu++11', '-fpermissive', '-fno-exceptions',
      '-ffunction-sections', '-fdata-sections', '-fno-threadsafe-statics',
      '-Wno-error=narrowing', '-fno-rtti'];
    if (lto) f.push('-flto');
    return f;
  }
  function cFlags(lto) {
    const f = ['-Os', '-std=gnu11', '-ffunction-sections', '-fdata-sections'];
    if (lto) f.push('-flto');
    return f;
  }

  function defines(b) {
    return [`F_CPU=${b.fcpu}`, `ARDUINO=${ARDUINO_VERSION}`,
      `ARDUINO_${b.board}`, 'ARDUINO_ARCH_AVR'].map((d) => `-D${d}`);
  }

  // Device-specific flags mined from the recorded native driver spec
  // (-mmcu=avr5, -D__AVR_*, -mn-flash, ...). lang is 'cc1' or 'cc1plus'.
  function deviceFlags(specText) {
    const line = specText.split('\n').find((l) =>
      /\/cc1(plus)?\s/.test(l) || (/\bcc1(plus)?\b/.test(l) && l.includes('-mmcu'))) || '';
    return line.trim().split(/\s+/).filter((t) =>
      /^-mmcu=/.test(t) || /^-mn-flash=/.test(t) || t === '-mno-skip-bug' ||
      t === '-mskip-bug' || t === '-msp8' || /^-mdouble=/.test(t) ||
      /^-mlong-double=/.test(t) || /^-D__AVR_/.test(t));
  }

  function linkTdata(specText) {
    const line = (specText || '').split('\n').find((l) =>
      (/collect2/.test(l) || /[ /]ld /.test(l)) && l.includes('-Tdata')) || '';
    const toks = line.trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === '-Tdata') return toks[i + 1];
      if (/^-Tdata/.test(toks[i])) return toks[i].slice(6);
    }
    return null;
  }

  const isCpp = (name) => /\.(cpp|cc|cxx|ino)$/.test(name);
  const isAsm = (name) => /\.(S)$/.test(name);

  // Build the cc1/cc1plus argv for one translation unit. `quote` is an
  // optional ['-iquote', dir] pair so a source's sibling headers resolve.
  function cc1Argv(b, specText, includeDirs, srcVfs, outVfs, lto, quote) {
    const inc = [];
    for (const d of includeDirs) inc.push('-isystem', d);
    const base = isCpp(srcVfs) ? cppFlags(lto) : cFlags(lto);
    const extra = [];
    if (lto) {
      // Every unit is compiled to the same /work/unit.s, and GCC derives an
      // LTO object's unique id from -frandom-seed (default: a hash of the
      // output name). Identical output names → identical ids → lto1 confuses
      // the objects and drops symbols. Seed it from the source path instead so
      // each LTO object gets a distinct id.
      extra.push('-frandom-seed=' + srcVfs.replace(/[^A-Za-z0-9]/g, '_'));
    }
    return ['-quiet', ...deviceFlags(specText), ...defines(b), ...(quote || []),
      ...inc, ...base, ...extra, srcVfs, '-o', outVfs];
  }

  // lto1 argv for a single-partition LTO recompile: merge all slim LTO
  // objects (listed in the @opts file) into one real-code assembly file.
  // We deliberately omit -fresolution (that symbol-resolution map is produced
  // by the GNU linker plugin, which wasm-binutils ld can't dlopen). Without it
  // lto1 stays conservative — it keeps externally-visible globals rather than
  // dead-stripping them — but still does cross-module inlining/optimization
  // within the single partition. The dead globals it conservatively keeps are
  // then removed by --gc-sections at the final link. Net: real LTO benefit,
  // no plugin required.
  function ltoArgv(b, specText, optsVfs, outVfs) {
    const dev = deviceFlags(specText).filter((t) => !/^-D/.test(t)); // -m flags only
    // The size win needs two flags working together:
    //  -fwhole-program : the real `-fresolution` symbol map is produced by the
    //    GNU linker plugin, which wasm-binutils ld can't dlopen. -fwhole-program
    //    achieves the same effect without it: it treats the merged set as the
    //    whole program, so everything except `main` and externally_visible
    //    symbols (Arduino ISRs are declared `used,externally_visible`) becomes
    //    internal and is eligible for dead-code elimination / inlining.
    //  -ffunction/-fdata-sections : make lto1 emit per-function/-data sections
    //    so --gc-sections at the final link can drop what's now provably dead.
    // Without -fwhole-program lto1 stays conservative and the binary is larger
    // than the non-LTO path; with it, LTO is actually smaller.
    return ['-quiet', ...dev, '-Os', '-ffunction-sections', '-fdata-sections',
      '-fwhole-program', '-flto-partition=none', '-flinker-output=exec',
      '@' + optsVfs, '-o', outVfs];
  }

  // The collect2/ld link line for a non-LTO (or post-lto1) AVR build.
  function linkArgv(b, opts) {
    const { scriptVfs, tdata, crtVfs, objVfs, coreVfs, libgccDir, libcDir, extraLibDirs, outVfs } = opts;
    const argv = ['-T', scriptVfs];
    if (tdata) argv.push('-Tdata', tdata);
    argv.push('--gc-sections', crtVfs, ...objVfs);
    if (coreVfs) argv.push(coreVfs);
    for (const d of extraLibDirs || []) argv.push(`-L${d}`);
    argv.push(`-L${libgccDir}`, `-L${libcDir}`,
      '--start-group', '-lgcc', '-lm', '-lc', `-l${b.mcu}`, '--end-group',
      '-o', outVfs);
    return argv;
  }

  // ── .ino -> .cpp with ctags-style forward-prototype generation ────────
  // Mirrors the Arduino builder: concatenate .ino files, ensure
  // #include <Arduino.h>, then inject prototypes for every top-level
  // function so call-before-definition works (the #1 reason a real sketch
  // fails to compile without preprocessing).
  function preprocessIno(source) {
    const code = source;
    const hasArduinoH = /^\s*#\s*include\s+<Arduino\.h>/m.test(code);

    // Mask out comments and string/char literals so we scan only real code.
    const masked = maskCommentsAndStrings(code);

    // Find the insertion point: after the last top-level preprocessor line /
    // before the first function definition or statement. Arduino inserts
    // prototypes right after the includes block; we use the first top-level
    // '{' of a function as the boundary and insert just before its line.
    const protos = collectPrototypes(masked, code);

    const header = (hasArduinoH ? '' : '#include <Arduino.h>\n');
    const insertAt = firstFunctionOffset(masked);
    const protoBlock = protos.length ? protos.join('\n') + '\n' : '';

    if (insertAt < 0 || !protoBlock) {
      return header + '#line 1\n' + code;
    }
    const before = code.slice(0, insertAt);
    const after = code.slice(insertAt);
    // Count newlines before insert so #line keeps error locations sane.
    const lineNo = before.split('\n').length;
    return header + before + protoBlock + `#line ${lineNo}\n` + after;
  }

  function maskCommentsAndStrings(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } }
      else if (c === '/' && d === '*') {
        out += '  '; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
        out += '  '; i += 2;
      } else if (c === '"' || c === '\'') {
        const q = c; out += ' '; i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') { out += '  '; i += 2; } else { out += src[i] === '\n' ? '\n' : ' '; i++; } }
        out += ' '; i++;
      } else { out += c; i++; }
    }
    return out;
  }

  // Offset of the first top-level function definition (depth-0 '(' ... ')' '{').
  function firstFunctionOffset(masked) {
    const m = scanTopLevelFunctions(masked);
    return m.length ? m[0].start : -1;
  }

  function collectPrototypes(masked, original) {
    const fns = scanTopLevelFunctions(masked);
    const seen = new Set(['setup', 'loop']);   // declared by Arduino.h
    const protos = [];
    for (const f of fns) {
      const sig = original.slice(f.start, f.parenEnd + 1).replace(/\s+/g, ' ').trim();
      const name = f.name;
      if (seen.has(name)) continue;
      seen.add(name);
      protos.push(sig + ';');
    }
    return protos;
  }

  // Scan for top-level (brace depth 0) function definitions in masked source.
  // Returns { start, name, parenEnd } (absolute offsets, valid in the original
  // too since masking preserves positions). Heuristic but handles ordinary
  // Arduino sketches; class/struct bodies raise depth so members are skipped.
  function scanTopLevelFunctions(s) {
    const res = [];
    let depth = 0;
    let lastStmtBoundary = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{') {
        if (depth === 0) {
          const head = s.slice(lastStmtBoundary, i);
          // returntype (qualified) name ( args ) [const]  at end of head
          const hm = head.match(/^([\s\S]*?)\b([A-Za-z_]\w*)\s*\(([^{};]*)\)\s*(?:const\s*)?$/);
          if (hm && hm[2] && !/\b(if|for|while|switch|do|return|sizeof|else|namespace)\s*$/.test(hm[1] + hm[2]) &&
              !/\b(struct|class|enum|union)\b/.test(hm[1])) {
            const leadWs = head.match(/^\s*/)[0].length;
            res.push({ start: lastStmtBoundary + leadWs, name: hm[2], parenEnd: s.lastIndexOf(')', i) });
          }
        }
        depth++;
      } else if (c === '}') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) lastStmtBoundary = i + 1;
      } else if (c === ';' && depth === 0) {
        lastStmtBoundary = i + 1;
      }
    }
    return res;
  }

  return {
    BOARDS, ARDUINO_VERSION, cppFlags, cFlags, defines, deviceFlags, linkTdata,
    cc1Argv, ltoArgv, linkArgv, preprocessIno, isCpp, isAsm,
  };
}));
