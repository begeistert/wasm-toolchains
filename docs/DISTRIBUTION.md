# Distribution pipeline

How the on-device compiler artifacts are built, packaged and shipped to a host app.

Everything is distributed as **runtime-downloaded blobs via GitHub Releases**, not
bundled in the app. This solves two problems at once: app size (~200 MB of WASM
toolchains stay out of the `.app`) and GPL licensing — the GPLv3 gcc/binutils are
fetched at arm's length, never linked into the proprietary app (see
[LICENSING.md](LICENSING.md)).

## Artifacts

| Artifact | Produced by | Shipped as |
|---|---|---|
| AVR toolchain bundle (`dist-web/`) | `tools/arduino-wasm/make-web-dist.cjs` | `avrwasm.tar` (AVR Release) |
| Pico toolchain + Tier-1 libs (`dist-pico-web/`) | `tools/pico-wasm/harvest.cjs` → `make-pico-dist.cjs` | `picowasm.tar` (Pico Release) |
| `catalog.json` | `tools/dist/make-catalog.cjs` | the manifest the host app reads (per toolchain Release) |
| header→library map | `tools/lib-index/scan-libraries.cjs` | `header-lib-map.json` (rolling `library-index` Release) |

`catalog.json` lists the toolchain bundle with a URL + `sha256` + size; the host app
fetches it, downloads what it needs, verifies the hash, and caches. Bump the version
and re-release to push a toolchain update **without an App Store release**.

The **header→library map is intentionally not in the toolchain catalogs**: it
changes weekly (the Arduino library ecosystem), so it ships via its own *rolling*
`library-index` Release that the host app reads directly — always fresh, decoupled
from the pinned toolchain versions. Pinning a rolling artifact's hash in a versioned
catalog would only go stale.

## Building the Pico bundle locally

Requires Docker + Node. The ARM WASM toolchain build is heavy (~hours); the harvest
needs the reproducible `picocap` image (arduino-cli + arduino-pico + Tier-1 libs).

```bash
docker buildx build --output=type=local,dest=dist-arm-gcc src/arm-gcc   # once, slow
docker build -t picocap:latest src/picocap                              # harvest env
node tools/pico-wasm/harvest.cjs dist-pico-web                          # bundle (4 boards)
node tools/pico-wasm/verify-pico.cjs dist-pico-web                      # flash-identical check
```

`harvest.cjs`: runs `harvest.sh` in `picocap` per board (wrapping cc1plus/ld to
capture their exact argv), tars the reference build + 3rd-party library sources,
mirrors them, picks the real cc1plus/ld invocations, computes the header closure
(`cc1plus -H`), then builds the multi-board bundle. Boards: `pico`, `pico2`,
`pico_w`, `pico2w` (ARM only; the tools + gcc `thumb` multilib are shared, only the
per-board link inputs / closure / cpu flags / UF2 family differ).

### Tier-1 libraries

`bigsketch.ino` `#include`s every library the host app may reimplement as a native shim
(NeoPixel, DHT, PWM Servo Driver + BusIO, MCP9808 + Unified Sensor, Keypad, Servo,
plus SPI/Wire/EEPROM). The harvest captures their headers into the closure and
their compiled objects into the link, so any user sketch using a subset compiles +
links on-device (`--gc-sections` drops the unused). Versions are pinned in
`src/picocap/Dockerfile`.

## Library index (cron)

`scan-libraries.cjs` builds the header→library map from the Arduino Library Manager
index. Most libraries declare their headers in `providesIncludes` (no download);
`--deep` fetches the rest and lists their `src/*.h`, cached by `(name, version)` so
runs are incremental. The map powers automatic resolution: the compiler's
`'X.h' file not found` triggers a lookup here → download + cache + recompile.

## Workflows

There are **two independent release tracks**, one per toolchain, so AVR and Pico
version and publish separately (no need to rebuild the ~hours Pico toolchain to
ship an AVR fix):

- `.github/workflows/release-avr.yml` — builds the AVR binutils + `avr-gcc`,
  assembles `dist-web` (`make-web-dist.cjs`), validates it by compiling a real
  sketch, then on an **`avr-v*`** tag runs `make-catalog.cjs` and publishes
  `avrwasm.tar` + `header-lib-map.json` + `catalog.json` to the **AVR Release**.
- `.github/workflows/release-pico.yml` — builds `arm-gcc`, harvests
  `dist-pico-web` (`harvest.cjs`), verifies flash-identical to native, then on a
  **`pico-v*`** tag publishes `picowasm.tar` + `catalog.json` to the **Pico
  Release**.

Both run **only on their tag** (full build → publish) and on manual
`workflow_dispatch` (build + validate, no publish); never on branch pushes or PRs.
Tag scheme: `avr-vX.Y.Z` and `pico-vX.Y.Z` (SemVer per toolchain). Each release's
`catalog.json` lists only that toolchain's assets, with URLs pointing at its own
release tag.

- `.github/workflows/scan-libraries.yml` — weekly cron (Mon 06:00 UTC) +
  `workflow_dispatch` → header→library map → rolling `library-index` release. The
  host app reads this directly for automatic library resolution; it is deliberately
  not bundled into the pinned toolchain catalogs.
