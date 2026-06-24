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
| AVR toolchain bundle (`dist-web/`) | `tools/arduino-wasm/make-web-dist.cjs` | `avrwasm.tar` |
| Pico toolchain + Tier-1 libs (`dist-pico-web/`) | `tools/pico-wasm/harvest.cjs` → `make-pico-dist.cjs` | `picowasm.tar` |
| header→library map | `tools/lib-index/scan-libraries.cjs` | `header-lib-map.json` |
| `catalog.json` | `tools/dist/make-catalog.cjs` | the manifest the host app reads |

`catalog.json` lists each bundle with a URL + `sha256` + size; the host app fetches it,
downloads what it needs, verifies the hash, and caches. Bump the version and
re-release to push a toolchain update **without an App Store release**.

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

- `.github/workflows/release.yml` — the unified build + release pipeline. Builds
  every toolchain (AVR binutils, `avr-gcc`, `arm-gcc`), assembles `dist-web`
  (`make-web-dist.cjs`) and `dist-pico-web` (`harvest.cjs`), validates each, then
  on a `v*` tag runs `make-catalog.cjs` over **the same run's** bundles and
  publishes `catalog.json` + the tarballs to the Release. The light binutils
  builds run on every push/PR as a smoke test; the heavy compiler builds + bundles
  run on `workflow_dispatch` and tags.
- `.github/workflows/scan-libraries.yml` — weekly cron → header→library map →
  rolling `library-index` release (fetched by the `release` job for the catalog).
