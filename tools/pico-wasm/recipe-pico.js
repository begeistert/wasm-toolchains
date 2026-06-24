// recipe-pico.js — pure, environment-agnostic recipe logic for the RP2040 / Pico
// on-device compiler. The browser pipeline (pico-pipeline.js) and the Node
// verifier (tools/pico-wasm/verify-pico.cjs) share this so they drive the exact
// same cc1plus / arm-as / arm-ld invocations. No I/O here.
//
// The arduino-pico core is precompiled (core.a + libpico/lwip/bearssl), so a
// build only recompiles the sketch translation unit and relinks. The argv
// templates are captured verbatim from a validated native build; we swap only
// the sketch source/object/output paths.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PicoRecipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // POSIX path.normalize for the '/bin/../' segments wasm-ld can't resolve.
  function normalize(p) {
    const abs = p.startsWith('/');
    const parts = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); }
      else parts.push(seg);
    }
    return (abs ? '/' : '') + parts.join('/');
  }

  // Minimal .ino -> .cpp transform (Arduino builder equivalent): prepend
  // <Arduino.h> and forward-declare the user's free functions so call-before-
  // definition compiles, mirroring arduino-wasm/recipe.js preprocessIno. The
  // toolchain itself is byte-identical to native given an identical .cpp; this
  // path is for sketches typed in-app (no native .cpp to diff against).
  function preprocessIno(src) {
    const proto = [];
    const re = /^[ \t]*((?:[A-Za-z_][\w:<>,&*\s]*?)\b[A-Za-z_]\w*[ \t]*\([^;{}]*\))[ \t]*\{/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      const sig = m[1].replace(/\s+/g, ' ').trim();
      if (/\b(if|for|while|switch|else|return|do|sizeof)\s*\($/.test(sig)) continue;
      if (/^(setup|loop)\b/.test(sig) || /\b(setup|loop)\s*\(/.test(sig)) continue;
      proto.push(sig + ';');
    }
    return '#include <Arduino.h>\n' + (proto.length ? proto.join('\n') + '\n' : '') +
      '#line 1 "sketch.ino"\n' + src + '\n';
  }

  // cc1plus argv: the captured template with -o repointed to our .s, the C++
  // -isystem dirs prepended (front of the search path), and -quiet hoisted.
  function cc1Argv(template, isystemDirs, outSVfs) {
    const t = template.slice();
    const oi = t.indexOf('-o');
    if (oi >= 0) t[oi + 1] = outSVfs;
    const body = t.filter((x) => x !== '-quiet');
    const isys = [];
    for (const d of isystemDirs) { isys.push('-isystem', d); }
    // Match arduino-pico's gcc default: bare-metal arm-none-eabi uses
    // -fno-use-cxa-atexit (static dtors via atexit, no __cxa_atexit/__dso_handle).
    // Our gcc build defaults the other way; without this a sketch with file-scope
    // C++ objects (e.g. `Adafruit_NeoPixel strip(...)`) emits an undefined
    // __dso_handle reference that wasm-ld can't resolve. The flag is absent from
    // the captured argv (it's a build default), so we add it to stay byte-identical.
    return ['-quiet', '-fno-use-cxa-atexit', ...isys, ...body];
  }

  // arm-as argv: the board's cpu flags (cortex-m0plus for rp2040, cortex-m33
  // +armv8-m.main+dsp+fp softfp for rp2350) drive the assembler.
  const asArgv = (asFlags, objVfs, sVfs) => [...asFlags, '-o', objVfs, sVfs];

  // arm-ld argv: normalize every path-bearing arg (resolves '/bin/../') and
  // repoint -o to our .elf. wasm-ld can't dlopen the LTO plugin, but these
  // builds are non-LTO so the captured argv links as-is.
  function ldArgv(template, outElfVfs) {
    const norm = (a) => {
      if (a.startsWith('/')) return normalize(a);
      if (a.startsWith('-L/')) return '-L' + normalize(a.slice(2));
      if (a.startsWith('--script=/')) return '--script=' + normalize(a.slice('--script='.length));
      return a;
    };
    const t = template.map(norm);
    const oi = t.indexOf('-o');
    if (oi >= 0) t[oi + 1] = outElfVfs;
    return t;
  }

  // bin -> UF2. flash base 0x10000000, 256 B payload/block. The family id keys
  // the emulator's Uf2ToFlash: rp2040=0xe48bff56, rp2350 Arm-Secure=0xe48bff59.
  // (rp2350's native uf2 also carries a 0xe48bff57 "absolute" metadata block,
  // but Uf2ToFlash skips that family, so we don't need to emit it.)
  function binToUf2(bin, family) {
    const FAMILY = family >>> 0, BASE = 0x10000000, PAY = 256;
    const nblocks = Math.ceil(bin.length / PAY) || 1;
    const uf2 = new Uint8Array(nblocks * 512);
    const dv = new DataView(uf2.buffer);
    for (let i = 0; i < nblocks; i++) {
      const o = i * 512;
      dv.setUint32(o, 0x0A324655, true);
      dv.setUint32(o + 4, 0x9E5D5157, true);
      dv.setUint32(o + 8, 0x00002000, true);          // familyID present
      dv.setUint32(o + 12, BASE + i * PAY, true);
      dv.setUint32(o + 16, PAY, true);
      dv.setUint32(o + 20, i, true);
      dv.setUint32(o + 24, nblocks, true);
      dv.setUint32(o + 28, FAMILY, true);
      uf2.set(bin.subarray(i * PAY, Math.min((i + 1) * PAY, bin.length)), o + 32);
      dv.setUint32(o + 512 - 4, 0x0AB16F30, true);
    }
    return uf2;
  }

  return { normalize, preprocessIno, cc1Argv, asArgv, ldArgv, binToUf2 };
});
