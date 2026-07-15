// recipe-pico-clang.js — pure, environment-agnostic recipe logic for the
// PERMISSIVE clang-based RP2040/RP2350 pipeline, the non-GPL twin of
// tools/pico-wasm/recipe-pico.js. Where the GCC recipe drives cc1plus/arm-as/
// arm-ld, this one drives clang (frontend + integrated assembler in one step)
// and lld — so the whole chain is Apache-2.0/BSD, no GPL cc1plus or binutils.
//
// The host runs two wasm modules: clang.wasm (.ino/.cpp -> .o, one call, no
// separate `as`) and lld.wasm (`-flavor gnu`, .o + libs -> .elf), then
// llvm-objcopy.wasm (.elf -> .bin) and binToUf2 in JS. No I/O here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PicoClangRecipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Same .ino -> .cpp transform as the GCC recipe (prepend <Arduino.h>,
  // forward-declare the user's free functions).
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

  // clang argv: compile ONE translation unit straight to an object (integrated
  // assembler — no gas step). `board.triple` + `board.clangFlags` pick the
  // backend (thumbv6m for RP2040, armv8m.main for RP2350). `-ffreestanding
  // -nostdlib` because we supply picolibc/compiler-rt explicitly at link.
  function clangArgv(board, isystemDirs, resourceDir, srcVfs, outObjVfs) {
    const isys = [];
    for (const d of isystemDirs) isys.push('-isystem', d);
    return [
      '-target', board.triple, ...board.clangFlags,
      '-Os', '-ffreestanding', '-fno-use-cxa-atexit', '-fno-exceptions', '-fno-rtti',
      '-resource-dir', resourceDir,   // clang.wasm's lib/clang/<v> (intrinsics + stddef/stdint)
      ...isys,
      '-c', srcVfs, '-o', outObjVfs,
    ];
  }

  // lld argv (ELF driver via `-flavor gnu`): object + the board's permissive
  // link inputs (crt0, core.a, picolibc libc.a, compiler-rt builtins) under a
  // linker script. `libDirs`/`libs`/`scriptVfs` are supplied by the caller from
  // the bundle manifest; everything is already an absolute VFS path.
  function ldArgv(objVfs, libDirs, libs, extraObjs, scriptVfs, outElfVfs) {
    const args = ['-flavor', 'gnu', '-o', outElfVfs, '-T', scriptVfs, '--gc-sections'];
    for (const d of libDirs) args.push('-L' + d);
    for (const o of extraObjs || []) args.push(o);
    args.push(objVfs);
    for (const l of libs) args.push(l);   // .a paths or -l names, order-sensitive
    return args;
  }

  // bin -> UF2 — identical format to the GCC pipeline (flash base 0x10000000,
  // 256 B payload/block; family rp2040=0xe48bff56, rp2350=0xe48bff59).
  function binToUf2(bin, family) {
    const FAMILY = family >>> 0, BASE = 0x10000000, PAY = 256;
    const nblocks = Math.ceil(bin.length / PAY) || 1;
    const uf2 = new Uint8Array(nblocks * 512);
    const dv = new DataView(uf2.buffer);
    for (let i = 0; i < nblocks; i++) {
      const o = i * 512;
      dv.setUint32(o, 0x0A324655, true);
      dv.setUint32(o + 4, 0x9E5D5157, true);
      dv.setUint32(o + 8, 0x00002000, true);
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

  return { preprocessIno, clangArgv, ldArgv, binToUf2 };
});
