# AVR Toolchain Tutorial: Assembly Source to Intel HEX

Complete pipeline using the WebAssembly tools in this repository.

```
source.s  ──►  avr-as (.o)  ──►  avr-ld (.elf)  ──►  objcopy (.hex)
```

All three tools are self-contained `.js` files — no native AVR toolchain needed.

---

## Files

| File | Role |
|------|------|
| `avr-as.js` | Assembles `.s` → `.o` |
| `avr-ld.js` | Links `.o` → `.elf` (avr-libc embedded) |
| `objcopy.js` | Converts `.elf` → Intel HEX `.hex` |

Download them from the [Releases page](../../releases/latest) or run the [Build workflow](../../actions/workflows/build.yml) manually.

---

## Device Reference

| Board | MCU | `-mmcu` flag | avr-libc arch | CRT object | LD emulation |
|-------|-----|---|---|---|---|
| Arduino UNO | ATmega328P | `atmega328p` | `avr5` | `crtatmega328p.o` | `avr5` |
| Arduino NANO | ATmega328P | `atmega328p` | `avr5` | `crtatmega328p.o` | `avr5` |
| Arduino MEGA | ATmega2560 | `atmega2560` | `avr6` | `crtatmega2560.o` | `avr6` |
| ATtiny85 | ATtiny85 | `attiny85` | `avr25` | `crtattiny85.o` | `avr25` |

---

## Loading the tools

Each `.js` file exposes an Emscripten `Module` factory.  Load it however is
appropriate for your environment (script tag, `importScripts`, dynamic import,
`require`, etc.) and call `Module({...})` with your options.

### Browser / WKWebView

```html
<script src="avr-as.js"></script>
<script>
  // Module is now available as a global
  Module({ print: console.log, printErr: console.error, ... }).then(m => {
    // use m.FS, m.callMain, etc.
  });
</script>
```

### Node.js

```js
const createModule = require("./avr-as.js");
const m = await createModule({ print: console.log, printErr: console.error });
```

---

## Step 1 — Assemble: `.s` → `.o`

```js
const gas = await createAvrAs({
  print:    (s) => console.log("[as]", s),
  printErr: (s) => console.error("[as]", s),
  arguments: [
    "-mmcu=atmega328p",   // target MCU
    "-o", "program.o",
    "program.s",
  ],
  preRun: [(m) => {
    m.FS.writeFile("program.s", `
        .arch avr5
        .text
        .global main
    main:
        ldi r16, 0xFF
        out 0x04, r16     ; DDRB = 0xFF (all outputs)
    loop:
        sbi 0x05, 5       ; set PB5 (LED on pin 13)
        rjmp loop
    `);
  }],
  postRun: [(m) => {
    objectBytes = m.FS.readFile("program.o");
  }],
});
```

> **Note:** If your source does not contain a `.arch` directive, pass the
> matching `-march=avr5` flag on the command line instead.

---

## Step 2 — Link: `.o` → `.elf`

avr-libc is embedded inside `avr-ld.js` — paths like `/usr/lib/avr/lib/avr5/`
exist in the virtual filesystem automatically.

```js
const archFamily = "avr5";               // from the device table above
const ldEmulation = "avr5";
const crtObject  = "crtatmega328p.o";
const libDir     = `/usr/lib/avr/lib/${archFamily}`;

const ld = await createAvrLd({
  print:    (s) => console.log("[ld]", s),
  printErr: (s) => console.error("[ld]", s),
  arguments: [
    "-m", ldEmulation,              // memory layout / emulation
    `${libDir}/${crtObject}`,       // device startup object
    "program.o",                    // assembled object
    `-L${libDir}`, "-lc",           // avr-libc
    "-o", "program.elf",
  ],
  preRun: [(m) => {
    m.FS.writeFile("program.o", objectBytes);
  }],
  postRun: [(m) => {
    elfBytes = m.FS.readFile("program.elf");
  }],
});
```

Add `-lm` before `-lc` if your program uses floating-point math.

---

## Step 3 — Convert: `.elf` → `.hex`

```js
const objcopy = await createObjcopy({
  print:    (s) => console.log("[objcopy]", s),
  printErr: (s) => console.error("[objcopy]", s),
  arguments: [
    "-O", "ihex",       // Intel HEX output
    "-R", ".eeprom",    // flash only (exclude EEPROM section)
    "program.elf",
    "program.hex",
  ],
  preRun: [(m) => {
    m.FS.writeFile("program.elf", elfBytes);
  }],
  postRun: [(m) => {
    hexString = m.FS.readFile("program.hex", { encoding: "utf8" });
  }],
});
```

To extract EEPROM data to a separate `.eep` file:

```js
arguments: [
  "-O", "ihex",
  "-j", ".eeprom",
  "--set-section-flags=.eeprom=alloc,load",
  "--no-change-warnings",
  "--change-section-lma", ".eeprom=0",
  "program.elf",
  "program.eep",
],
```

---

## Adding More Devices

1. Open [`src/avr-ld/devices.sh`](../src/avr-ld/devices.sh).
2. Find the device in the [avr-libc device list](https://avrdudes.github.io/avr-libc/avr-libc-user-manual/index.html).
3. Append one line:

   ```bash
   DEVICES=(
     "arduino-uno:atmega328p:avr5:crtatmega328p.o"
     # ...
     "atmega1284p:atmega1284p:avr51:crtm1284p.o"   # ← new
   )
   ```

4. Rebuild (`docker buildx build ... src/avr-ld`).

---

## Offline Use (iOS / MAUI)

Each `.js` file uses `-sSINGLE_FILE=1` — the WASM binary is base64-encoded
inside the JS file itself, so there is only one file per tool to manage.

Suggested approach for a C# MAUI / iOS app:

1. Fetch the three `.js` files once (from the GitHub Releases page) and write
   them to local app storage.
2. Load them in a `WKWebView` via a custom URL scheme or a local HTTP server.
3. Call the tools from JavaScript running inside the WebView, passing assembly
   source in and reading the Intel HEX result out.

After the initial download the app works fully offline.

