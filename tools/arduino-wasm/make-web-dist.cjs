// make-web-dist.cjs — assemble a minimal, iOS/WKWebView-shippable bundle.
//
// The full build sidecar is ~290 MB (every AVR arch, every device lib, every
// libgcc multilib). A browser only needs the arches for the boards we expose,
// so we copy just those plus the tool modules, the Arduino core, and a
// manifest.json the browser host fetches to populate MEMFS.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { target } = require('../targets/registry.cjs');

const root = path.resolve(__dirname, '..', '..');
const dist = path.join(root, 'dist-avr-gcc');         // full build output
const core = path.join(root, 'src', 'arduino-core');
const libsRoot = path.join(root, 'libraries');        // bundled libraries
const out = path.join(root, 'dist-web');

// Boards -> the arch/mcu whose target files must travel with the bundle. Values
// come from the target registry; we project just the fields this bundle ships
// (the manifest's board shape stays {board, mcu, arch, crt, variant}).
const BOARDS = target('avr-toolchain').boards.map((b) => ({
  board: b.key, mcu: b.mcu, arch: b.arch, crt: b.crt, variant: b.variant,
}));

function copy(src, dstRel) {
  const dst = path.join(out, dstRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dstRel;
}
function copyTree(srcDir, dstRel, filter = () => true) {
  const rels = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && filter(full)) {
        const r = path.join(dstRel, path.relative(srcDir, full));
        copy(full, r); rels.push(r);
      }
    }
  };
  walk(srcDir);
  return rels;
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const manifest = { tools: [], specs: [], sysroot: [], core: [], libraries: {}, boards: BOARDS };

// 1. Tool modules (the WASM that runs on iOS). cc1/cc1plus/lto1 ship as a
// .js loader + a separate .wasm (smaller, brotli-friendly); the binutils
// tools are single-file .js. Copy whatever exists for each.
// lto1 enables the optional --lto path (whole-program LTO, ~16% smaller on
// real sketches). ~4 MB brotli; include it so iOS can compile with LTO too.
const TOOL_FILES = ['cc1.js', 'cc1.wasm', 'cc1plus.js', 'cc1plus.wasm',
  'lto1.js', 'lto1.wasm', 'avr-as.js', 'avr-ld.js', 'ar.js', 'objcopy.js'];
for (const t of TOOL_FILES) {
  const src = path.join(dist, t);
  if (fs.existsSync(src)) manifest.tools.push(copy(src, path.join('tools', t)));
}
// Shared recipe logic (UMD) — loaded by the browser orchestrator.
copy(path.join(__dirname, 'recipe.js'), 'recipe.js');

// 2. Driver specs (per-mcu cc1plus/link argv).
manifest.specs = copyTree(path.join(dist, 'specs'), 'specs');

// 3. Headers (shared by all boards) — avr-libc + gcc internal.
manifest.sysroot.push(...copyTree(path.join(dist, 'sysroot', 'avr', 'include'), 'sysroot/avr/include'));
manifest.sysroot.push(...copyTree(path.join(dist, 'sysroot', 'gcc-include'), 'sysroot/gcc-include'));

// 4. Per-arch target libs (only the arches our boards use).
const arches = [...new Set(BOARDS.map((b) => b.arch))];
for (const arch of arches) {
  const libdir = path.join(dist, 'sysroot', 'avr', 'lib', arch);
  // libc.a, libm.a, and every device lib + crt for boards on this arch.
  for (const f of ['libc.a', 'libm.a'])
    manifest.sysroot.push(copy(path.join(libdir, f), `sysroot/avr/lib/${arch}/${f}`));
  for (const b of BOARDS.filter((b) => b.arch === arch)) {
    manifest.sysroot.push(copy(path.join(libdir, b.crt), `sysroot/avr/lib/${arch}/${b.crt}`));
    manifest.sysroot.push(copy(path.join(libdir, `lib${b.mcu}.a`), `sysroot/avr/lib/${arch}/lib${b.mcu}.a`));
  }
  // ldscripts for this arch.
  const lds = path.join(dist, 'sysroot', 'avr', 'lib', 'ldscripts');
  for (const v of ['x', 'xn', 'xbn', 'xr', 'xu'])
    if (fs.existsSync(path.join(lds, `${arch}.${v}`)))
      manifest.sysroot.push(copy(path.join(lds, `${arch}.${v}`), `sysroot/avr/lib/ldscripts/${arch}.${v}`));
  // libgcc.a for this arch (base multilib variant).
  manifest.sysroot.push(copy(path.join(dist, 'sysroot', 'libgcc', arch, 'libgcc.a'),
    `sysroot/libgcc/${arch}/libgcc.a`));
}

// 5. Arduino core + the variants our boards use.
manifest.core.push(...copyTree(path.join(core, 'cores', 'arduino'), 'arduino-core/cores/arduino'));
for (const variant of [...new Set(BOARDS.map((b) => b.variant))])
  manifest.core.push(...copyTree(path.join(core, 'variants', variant), `arduino-core/variants/${variant}`));

// 6. Bundled libraries. Each becomes manifest.libraries[name] = { include,
// files } so the browser orchestrator can fetch + compile a chosen subset.
if (fs.existsSync(libsRoot)) {
  for (const name of fs.readdirSync(libsRoot)) {
    const libDir = path.join(libsRoot, name);
    if (!fs.statSync(libDir).isDirectory()) continue;
    const srcDir = fs.existsSync(path.join(libDir, 'src')) ? path.join(libDir, 'src') : libDir;
    const files = copyTree(srcDir, `libraries/${name}`, (f) =>
      /\.(c|cpp|cc|cxx|S|h|hpp|inc)$/.test(f) && !/[/\\](examples|extras)[/\\]/.test(f));
    manifest.libraries[name] = { include: `libraries/${name}`, files };
  }
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Brotli-compress the big artifacts (.wasm, .js, .a) for shipping. The iOS
// host serves these with `Content-Encoding: br` (WKURLSchemeHandler) so the
// browser transparently inflates them; the uncompressed copies stay for
// hosts that don't. Brotli on raw wasm is ~3x; on the base64 .js much less.
let raw = 0, comp = 0;
const allFiles = [];
const walkAll = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name); if (e.isDirectory()) walkAll(f); else allFiles.push(f); } };
walkAll(out);
for (const f of allFiles) {
  const st = fs.statSync(f); raw += st.size;
  if (/\.(wasm|js|a)$/.test(f) && st.size > 65536) {
    const br = zlib.brotliCompressSync(fs.readFileSync(f), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    fs.writeFileSync(f + '.br', br);
    comp += br.length;
  }
}
// Effective iOS ship size: serve .br where present (host inflates via
// Content-Encoding: br), raw otherwise.
let ship = 0;
for (const f of allFiles) {
  if (f.endsWith('.br')) continue;
  ship += fs.existsSync(f + '.br') ? fs.statSync(f + '.br').size : fs.statSync(f).size;
}
console.log(`dist-web ready: ${manifest.tools.length} tool files, ${manifest.sysroot.length} sysroot, ` +
  `${manifest.core.length} core — ${(raw / 1048576).toFixed(1)} MB raw on disk; ` +
  `iOS ship size (brotli where available): ${(ship / 1048576).toFixed(1)} MB`);
