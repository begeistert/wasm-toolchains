// registry.test.cjs — guards the Phase-1 refactor: the target registry must
// reproduce, exactly, the board/bundle tables that used to live inline in the
// build scripts. Run: node tools/targets/registry.test.cjs
'use strict';
const assert = require('assert');
const reg = require('./registry.cjs');

let pass = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); pass++; };

// ── AVR: make-web-dist's shipped board shape ────────────────────────────────
eq(
  reg.target('avr-toolchain').boards.map((b) => ({
    board: b.key, mcu: b.mcu, arch: b.arch, crt: b.crt, variant: b.variant,
  })),
  [
    { board: 'uno',  mcu: 'atmega328p', arch: 'avr5', crt: 'crtatmega328p.o', variant: 'standard' },
    { board: 'nano', mcu: 'atmega328p', arch: 'avr5', crt: 'crtatmega328p.o', variant: 'standard' },
    { board: 'mega', mcu: 'atmega2560', arch: 'avr6', crt: 'crtatmega2560.o', variant: 'mega' },
  ],
  'AVR board table drifted',
);

// ── Pico harvest: board key -> { fqbn, tag } for the whole track ────────────
eq(
  Object.fromEntries(reg.boardsForTrack('pico-v').map((b) => [b.key, { fqbn: b.fqbn, tag: b.tag }])),
  {
    pico:   { fqbn: 'rpipico',   tag: 'pico' },
    pico2:  { fqbn: 'rpipico2',  tag: 'pico2' },
    pico_w: { fqbn: 'rpipicow',  tag: 'picow' },
    pico2w: { fqbn: 'rpipico2w', tag: 'pico2w' },
  },
  'Pico harvest board table drifted',
);

// ── Pico bundle: mcu / UF2 family / assembler cpu flags ─────────────────────
const armM0 = ['-mcpu=cortex-m0plus', '-mthumb'];
const armM33 = ['-mcpu=cortex-m33', '-mthumb', '-mfloat-abi=softfp', '-march=armv8-m.main+dsp+fp'];
eq(
  Object.fromEntries(Object.values(reg.boardMapForTrack('pico-v'))
    .map((b) => [b.key, { mcu: b.mcu, family: Number(b.family), asFlags: b.asFlags }])),
  {
    pico:   { mcu: 'rp2040', family: 0xe48bff56, asFlags: armM0 },
    pico2:  { mcu: 'rp2350', family: 0xe48bff59, asFlags: armM33 },
    pico_w: { mcu: 'rp2040', family: 0xe48bff56, asFlags: armM0 },
    pico2w: { mcu: 'rp2350', family: 0xe48bff59, asFlags: armM33 },
  },
  'Pico bundle board params drifted',
);

// ── Defaults the scripts relied on ──────────────────────────────────────────
eq(reg.baseBundle('pico-v').boards.map((b) => b.key).join(','), 'pico,pico2', 'pico default board set drifted');
eq(reg.baseBundle('pico-v').gcc, '14.3.0', 'pico gcc version drifted');
eq(reg.baseBundle('pico-v').harvest.image, 'picocap:latest', 'picocap image drifted');

// ── Catalog: publishable bundles in id order; the overlay carries `requires` ──
eq(
  Object.values(reg.loadAll()).filter((t) => t.tar && t.distDir).sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({ id: t.id, tar: t.tar, requires: t.extends || null })),
  [
    { id: 'avr-toolchain',     tar: 'avrwasm.tar',     requires: null },
    { id: 'esp32-toolchain',   tar: 'esp32wasm.tar',   requires: null },
    { id: 'esp32c3-toolchain', tar: 'esp32c3wasm.tar', requires: null },
    { id: 'llvm-toolchain',    tar: 'llvmwasm.tar',    requires: null },
    { id: 'pico-toolchain',    tar: 'picowasm.tar',    requires: null },
    { id: 'pico-wireless',     tar: 'picowwasm.tar',   requires: 'pico-toolchain' },
  ],
  'Catalog bundle list drifted',
);

// ── ESP track: two independent chips (different ISAs, no shared tools) ───────
eq(reg.bundlesForTrack('esp-v').map((t) => t.chip).sort(), ['esp32', 'esp32c3'], 'esp track chips drifted');
// Xtensa: BUILD the per-chip static triple, HARVEST the unified native triple.
eq(reg.target('esp32-toolchain').gccTarget, 'xtensa-esp32-elf', 'esp32 build target drifted');
eq(reg.target('esp32-toolchain').nativeTarget, 'xtensa-esp-elf', 'esp32 native (harvest) target drifted');
eq(reg.target('esp32c3-toolchain').gccTarget, 'riscv32-esp-elf', 'esp32c3 gcc target drifted');
eq(reg.target('esp32-toolchain').flash.app, '0x10000', 'esp32 app flash offset drifted');

// ── LLVM track: one multi-target backend, no boards, on its own track ────────
eq(reg.bundlesForTrack('llvm-v').map((t) => t.id), ['llvm-toolchain'], 'llvm track drifted');
eq(reg.target('llvm-toolchain').llvmTools, ['llc', 'opt', 'lld', 'llvm-mc', 'llvm-objcopy'], 'llvm tool list drifted');
eq(reg.boardsForTrack('llvm-v'), [], 'llvm track must have no boards');

// ── Overlay rides the same release track as its base ────────────────────────
eq(reg.bundlesForTrack('pico-v').map((t) => t.id), ['pico-toolchain', 'pico-wireless'], 'pico track bundle order drifted');
eq(reg.target('pico-wireless').extends, 'pico-toolchain', 'overlay base drifted');

console.log(`registry.test.cjs: ${pass} checks passed`);
