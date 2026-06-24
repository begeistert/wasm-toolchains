# Licensing & shipping inside a proprietary app

**Not legal advice** — this is an informed engineering summary; get it reviewed
by counsel before shipping. The relevant precedent is the well-known removal of
VLC (and other GPL apps) from Apple's App Store.

## What each piece is

| Component | License |
|---|---|
| `cc1`, `cc1plus`, `lto1` (GCC) | **GPLv3** |
| `avr-as`, `avr-ld`, `objcopy`, `ar` (binutils) | **GPLv3** |
| `libgcc.a` | GPLv3 **with GCC Runtime Library Exception** |
| `libc.a`, `libm.a` (avr-libc) | **BSD-2-Clause** (permissive) |
| Your orchestrator (`recipe.js`, `compiler.cjs`, `arduino-pipeline.js`) | yours |

## Three independent questions

**1. Is the compiled firmware (the user's `.hex`) GPL?** No. GCC's Runtime
Library Exception and the FSF's stated position make the output the user's own
work. No copyleft reaches your customers' sketches.

**2. Does bundling the GPL tools make your app itself GPL?** Not if you talk to
them **at arm's length** — which this architecture does by design. The host app
loads `cc1plus.wasm` as a *separate module* and drives it through a **data
interface** (argv + a virtual filesystem: bytes in, bytes out). It does not
link GCC code into the app. That is exactly how any IDE invokes `gcc`/`clang`,
and the FSF treats arm's-length invocation as *mere aggregation*, not a
derivative work. So the host app's own code stays proprietary.

**3. Can you ship the GPL binaries through the App Store?** **No.** GPLv3 (and
even GPLv2) is incompatible with Apple's App Store terms, which add usage
restrictions (DRM, device limits, non-transferability) that the GPL forbids.
Bundling the GPL `.wasm` in the IPA is a license violation.

## The shipping strategy: download the GPL tools as a blob

1. Publish **your app without the compiler** on the App Store (100% yours, no
   GPL code in the IPA).
2. On first use, **download** `cc1plus.wasm`, `avr-as`, `avr-ld`, … from **your
   server or GitHub Releases**, under GPLv3, directly to the user.
3. Now Apple distributes only your app; *you* (or GitHub) distribute the GPL
   blobs, outside Apple's terms. The App-Store↔GPL conflict disappears.

This works because of (2) **and** the arm's-length interface in question 2 — the
download is not a magic GPL eraser. Obligations that remain, **only for the
downloaded binaries** (never for your app):

- Provide the **corresponding source** for the GPL binaries you distribute. In
  this project that's upstream GCC/binutils plus the build recipe
  (`src/avr-gcc/Dockerfile` + `build.sh`); offer it (a written offer or a link
  is fine).
- Keep copyright/license notices.
- Any *modifications to GCC/binutils themselves* must be GPL. Your build scripts
  and orchestrator are **not** modifications of the compiler.

## If you want zero copyleft in the bundle

Switch the compiler to **LLVM/clang** (Apache-2.0-with-LLVM-exception,
permissive — bundle freely, App Store OK). Caveats: the LLVM AVR backend is
experimental, and the GNU **linker** `ld` is still GPL, so you'd use `lld`
(limited AVR support) or still download `ld` as a blob. `avr-libc` is permissive
and `libgcc` carries the Runtime Exception, so both can be bundled.

**Recommendation:** GCC + downloaded blobs keeps full Arduino fidelity (the
chosen `avr-gcc`) and is the fastest clean path to ship. Evaluate clang only if
you later want a fully copyleft-free bundle.
