# Running the WASM Tools in a Desktop Environment and in a MAUI App

This guide shows how to use the compiled `.js` tools (`avr-as.js`, `avr-ld.js`, `objcopy.js`, …) in two host environments:

1. **Desktop** — Node.js (Windows / macOS / Linux)
2. **MAUI app** — .NET MAUI with a `WKWebView` (WebKit) on macOS / iOS, or `WebView2` on Windows

All tools are self-contained single-file Emscripten modules.  The WASM binary is base64-encoded inside each `.js` file, so there are no extra assets to manage **for the tools themselves**.

The linker (`avr-ld.js`) additionally needs the AVR C runtime objects and libraries (`crt<mcu>.o`, `libc.a`, `libm.a`, …).  These are shipped alongside `avr-ld.js` as a sidecar `avr-libc/<arch>/` tree (the same layout used by a native `avr-gcc` install) and must be loaded into Emscripten's in-memory filesystem before invoking the linker.  Embedding them directly into `avr-ld.js` is not possible because the binutils `ld` link rule goes through libtool, which silently strips emcc driver flags such as `--embed-file`.

---

## 1. Desktop — Node.js

### Requirements

- Node.js ≥ 18

### Installation

Download the `.js` files from the [Releases page](../../releases/latest) or copy them from a local build (`dist/` folder).

```
your-project/
├── avr-as.js
├── avr-ld.js
├── objcopy.js
├── avr-libc/             ← sidecar tree shipped with avr-ld.js
│   ├── avr5/
│   │   ├── libc.a
│   │   ├── libm.a
│   │   └── crtatmega328p.o    ← per-device CRT object
│   ├── avr6/…
│   └── avr25/…
└── assemble.mjs          ← your code
```

### Full pipeline example (`assemble.mjs`)

```js
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Load each tool's module factory
const createAvrAs  = require("./avr-as.js");
const createAvrLd  = require("./avr-ld.js");
const createObjcopy = require("./objcopy.js");

const source = `
    .arch avr5
    .text
    .global main
main:
    ldi r16, 0xFF
    out 0x04, r16
loop:
    sbi 0x05, 5
    rjmp loop
`;

// ── Step 1: Assemble .s → .o ────────────────────────────────────────────────
let objectBytes;
await createAvrAs({
  print:    (s) => console.log("[as]", s),
  printErr: (s) => console.error("[as]", s),
  arguments: ["-mmcu=atmega328p", "-o", "program.o", "program.s"],
  preRun:  [(m) => m.FS.writeFile("program.s", source)],
  postRun: [(m) => { objectBytes = m.FS.readFile("program.o"); }],
});

// ── Step 2: Link .o → .elf ──────────────────────────────────────────────────
const archFamily = "avr5";
const ldEmulation = "avr5";
const crtObject  = "crtatmega328p.o";
const libDir     = `/usr/lib/avr/lib/${archFamily}`;

let elfBytes;
await createAvrLd({
  print:    (s) => console.log("[ld]", s),
  printErr: (s) => console.error("[ld]", s),
  arguments: [
    "-m", ldEmulation,
    `${libDir}/${crtObject}`,
    "program.o",
    `-L${libDir}`, "-lc",
    "-o", "program.elf",
  ],
  preRun: [(m) => {
    // Mirror the avr-libc sidecar tree into MEMFS so the linker can
    // resolve -L/usr/lib/avr/lib/<arch> and the crt object path.
    m.FS.mkdirTree(libDir);
    for (const name of [crtObject, "libc.a", "libm.a"]) {
      m.FS.writeFile(
        `${libDir}/${name}`,
        readFileSync(`./avr-libc/${archFamily}/${name}`),
      );
    }
    m.FS.writeFile("program.o", objectBytes);
  }],
  postRun: [(m) => { elfBytes = m.FS.readFile("program.elf"); }],
});

// ── Step 3: Convert .elf → .hex ─────────────────────────────────────────────
let hexString;
await createObjcopy({
  print:    (s) => console.log("[objcopy]", s),
  printErr: (s) => console.error("[objcopy]", s),
  arguments: ["-O", "ihex", "-R", ".eeprom", "program.elf", "program.hex"],
  preRun:  [(m) => m.FS.writeFile("program.elf", elfBytes)],
  postRun: [(m) => { hexString = m.FS.readFile("program.hex", { encoding: "utf8" }); }],
});

writeFileSync("program.hex", hexString);
console.log("Done →", hexString.slice(0, 80), "…");
```

Run it:

```bash
node assemble.mjs
```

---

## 2. .NET MAUI — WKWebView (WebKit)

The tools run entirely inside a WebView.  JavaScript calls the Emscripten modules and the results are passed back to C# via the JavaScript ↔ native bridge.

### Architecture overview

```
C# MAUI app
└── WKWebView  (WebKit on macOS/iOS)  /  WebView2 (Windows)
    ├── avr-as.js    ← loaded from app bundle / local storage
    ├── avr-ld.js
    ├── objcopy.js
    └── pipeline.js  ← your glue code (calls the three modules)
```

### 2.1 Add the JS files to the MAUI project

1. Download the three `.js` files from the [Releases page](../../releases/latest).
2. Place them in the `Resources/Raw/` folder of your MAUI project (this copies them to the app bundle on every platform).
3. Set **Build Action → MauiAsset** in the Visual Studio properties panel.

```
MyMauiApp/
└── Resources/
    └── Raw/
        ├── avr-as.js
        ├── avr-ld.js
        ├── objcopy.js
        ├── pipeline.js
        └── avr-libc/
            ├── avr5/
            │   ├── libc.a
            │   ├── libm.a
            │   └── crtatmega328p.o
            ├── avr6/…
            └── avr25/…
```

### 2.2 Create the WebView page (`AvrPage.xaml`)

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="MyMauiApp.AvrPage">
    <WebView x:Name="WebViewCtrl"
             HorizontalOptions="Fill"
             VerticalOptions="Fill" />
</ContentPage>
```

### 2.3 Load the tools and bridge (`AvrPage.xaml.cs`)

```csharp
using Microsoft.Maui.Controls;

namespace MyMauiApp;

public partial class AvrPage : ContentPage
{
    public AvrPage()
    {
        InitializeComponent();
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();

        // Read the JS files from the app bundle
        string avrAs     = await ReadRawAsset("avr-as.js");
        string avrLd     = await ReadRawAsset("avr-ld.js");
        string objcopy   = await ReadRawAsset("objcopy.js");
        string pipeline  = await ReadRawAsset("pipeline.js");

        // Build a self-contained HTML page that inlines all scripts
        string html = $"""
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8" /></head>
            <body>
            <script>{avrAs}</script>
            <script>{avrLd}</script>
            <script>{objcopy}</script>
            <script>{pipeline}</script>
            </body>
            </html>
            """;

        WebViewCtrl.Source = new HtmlWebViewSource { Html = html };
    }

    // Call from C# to trigger assembly and retrieve the HEX result
    public async Task<string> AssembleAsync(string asmSource)
    {
        // Escape the source for embedding in a JS string literal
        string escaped = asmSource
            .Replace("\\", "\\\\")
            .Replace("`",  "\\`")
            .Replace("$",  "\\$");

        string js = $"window.runPipeline(`{escaped}`)";
        return await WebViewCtrl.EvaluateJavaScriptAsync(js) ?? string.Empty;
    }

    private static async Task<string> ReadRawAsset(string filename)
    {
        using var stream = await FileSystem.OpenAppPackageFileAsync(filename);
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync();
    }
}
```

### 2.4 Create the JS glue layer (`Resources/Raw/pipeline.js`)

This file runs inside the WebView.  It exposes a single `window.runPipeline` function that C# calls via `EvaluateJavaScriptAsync`.

```js
// pipeline.js — runs inside WKWebView / WebView2
// Depends on: avr-as.js, avr-ld.js, objcopy.js being loaded first.

window.runPipeline = async function (asmSource) {
  // ── Step 1: Assemble ─────────────────────────────────────────────────────
  let objectBytes;
  await Module_avr_as({         // global set by avr-as.js
    arguments: ["-mmcu=atmega328p", "-o", "program.o", "program.s"],
    preRun:  [(m) => m.FS.writeFile("program.s", asmSource)],
    postRun: [(m) => { objectBytes = m.FS.readFile("program.o"); }],
  });

  // ── Step 2: Link ─────────────────────────────────────────────────────────
  const libDir = "/usr/lib/avr/lib/avr5";
  let elfBytes;
  await Module_avr_ld({         // global set by avr-ld.js
    arguments: [
      "-m", "avr5",
      `${libDir}/crtatmega328p.o`,
      "program.o",
      `-L${libDir}`, "-lc",
      "-o", "program.elf",
    ],
    preRun: [async (m) => {
      // Fetch the avr-libc sidecar files (shipped next to avr-ld.js)
      // and inject them into MEMFS at the path the linker expects.
      m.FS.mkdirTree(libDir);
      for (const name of ["crtatmega328p.o", "libc.a", "libm.a"]) {
        const r = await fetch(`avr-libc/avr5/${name}`);
        m.FS.writeFile(`${libDir}/${name}`,
          new Uint8Array(await r.arrayBuffer()));
      }
      m.FS.writeFile("program.o", objectBytes);
    }],
    postRun: [(m) => { elfBytes = m.FS.readFile("program.elf"); }],
  });

  // ── Step 3: Convert to Intel HEX ─────────────────────────────────────────
  let hexString;
  await Module_objcopy({        // global set by objcopy.js
    arguments: ["-O", "ihex", "-R", ".eeprom", "program.elf", "program.hex"],
    preRun:  [(m) => m.FS.writeFile("program.elf", elfBytes)],
    postRun: [(m) => { hexString = m.FS.readFile("program.hex", { encoding: "utf8" }); }],
  });

  return hexString;
};
```

> **Note:** Emscripten modules built with `-sMODULARIZE=1` export a factory
> function rather than auto-executing globals.  If the compiled files name their
> factory `Module` you will need to rename them (e.g. via a small wrapper) so
> they do not collide: `const Module_avr_as = Module; /* then load next file */`.
> Alternatively, load each file in a separate `<iframe>` or use dynamic
> `import()` if the build supports ES modules.

### 2.5 Call from C#

```csharp
string source = @"
    .arch avr5
    .text
    .global main
main:
    ldi r16, 0xFF
    out 0x04, r16
loop:
    sbi 0x05, 5
    rjmp loop
";

string hex = await avrPage.AssembleAsync(source);
Console.WriteLine(hex);
```

### 2.6 Windows — WebView2 differences

On Windows MAUI uses `WebView2` (Chromium-based) instead of `WKWebView`.
The same C# code and JS files work without modification; WebView2 also supports
`EvaluateJavaScriptAsync`.  One caveat: WebView2 requires a `CoreWebView2`
environment to be initialised before the first navigation — MAUI handles this
automatically when the `WebView` control appears on screen.

---

## Tips

| Topic | Guidance |
|-------|----------|
| **Offline use** | All three `.js` files use `-sSINGLE_FILE=1` — the WASM binary is embedded.  The avr-libc sidecar (`avr-libc/<arch>/`) ships next to `avr-ld.js` and is loaded at runtime; no network access is needed once both are in the app bundle. |
| **Memory** | The AVR tools are small; each module typically uses < 20 MB of Wasm memory.  Increase with `-sINITIAL_MEMORY` / `-sMAXIMUM_MEMORY` if needed (requires a custom build). |
| **Multiple runs** | Create a fresh `Module()` instance for each invocation; Emscripten modules are not designed for re-entrant use. |
| **Error handling** | Pass a `printErr` callback to capture diagnostic output.  `callMain` returns the process exit code. |
| **Other devices** | Consult the [Device Reference](AVR_TOOLCHAIN.md#device-reference) for the correct `-mmcu`, `ldEmulation`, and `crtObject` values for your target MCU. |
