# MAUI AVR Assembler example

A minimal **.NET MAUI** app that lets you type an Arduino sketch, pick a
target board, and compile it to an Intel HEX file **entirely on-device** —
using the WebAssembly builds of the AVR compiler (`cc1plus`), GNU `as`,
GNU `ld` and GNU `objcopy` from this repository.

The whole toolchain runs inside MAUI's `HybridWebView` (`WKWebView` on
iOS / Mac Catalyst, the system WebView on Android), so there is **no
native code** beyond MAUI itself.  The example is therefore
iOS-compatible by design: nothing you would need entitlements for,
nothing the App Store would reject.

```
┌──────────────────────────┐    InvokeJavaScriptAsync      ┌─────────────────────┐
│ MAUI page (C#)           │ ─────────────────────────────►│ HybridWebView       │
│  • Editor (asm source)   │                               │  • avr-as.js  (wasm)│
│  • Picker (device)       │ ◄──── { ok, hex, log } ──────│  • avr-ld.js  (wasm)│
│  • "Compile" button      │                               │  • objcopy.js (wasm)│
│  • HEX / log output      │                               │  • avr-libc/  data  │
└──────────────────────────┘                               └─────────────────────┘
```

## Project layout

```
examples/maui-avr-assembler/
├── MauiAvrAssembler.csproj           net9.0-ios;net9.0-maccatalyst;net9.0-android
├── MauiProgram.cs                    standard MAUI bootstrap
├── App.xaml(.cs)                     application + window
├── MainPage.xaml(.cs)                UI + bridge to JS
├── Models.cs                         CompileRequest / CompileResult + JsonContext
├── Platforms/
│   ├── iOS/                          AppDelegate, Info.plist
│   ├── MacCatalyst/                  AppDelegate, Info.plist, Entitlements.plist
│   └── Android/                      MainApplication, MainActivity, AndroidManifest
├── Resources/
│   ├── AppIcon/appicon.svg
│   ├── Splash/splash.svg
│   └── Raw/arduinowasm/
│       ├── index.html                loads the WASM compiler modules + recipe
│       ├── arduino-pipeline.js       window.compile() — chains cc1plus → as → ld → objcopy
│       ├── dist-web/                 the compiler bundle (see step 1)
│       └── .gitignore                excludes the binary artifacts
└── README.md                         (this file)
```

## Prerequisites

- **.NET 9 SDK** with the `maui`, `maui-ios`, `maui-maccatalyst` and
  `maui-android` workloads:
  ```bash
  dotnet workload install maui
  ```
- **For iOS / Mac Catalyst**: macOS host with the matching Xcode and
  command-line tools.
- **For Android**: any host plus the Android SDK installed by the
  workload.

## 1.  Drop the WASM bundle into the project

The compiler bundle (`dist-web/`: the tool `.js`/`.wasm`, the trimmed sysroot,
the Arduino core and `manifest.json`) is produced by `make-web-dist.cjs` and
attached to every release as `avrwasm.tar` by the `Release` GitHub Actions
workflow.  From inside this example folder:

```bash
# Either grab it from the latest release …
gh release download --repo begeistert/wasm-toolchains \
    --pattern 'avrwasm.tar'
mkdir -p Resources/Raw/arduinowasm/dist-web
tar xf avrwasm.tar -C Resources/Raw/arduinowasm/dist-web

# … or copy it from your own local build:
cp -R ../../dist-web Resources/Raw/arduinowasm/dist-web
```

`Resources/Raw/arduinowasm/.gitignore` keeps these binary artifacts out of
git so the example folder stays small.

The expected final layout under `Resources/Raw/arduinowasm/` is:

```
index.html             (provided)
arduino-pipeline.js    (provided)
dist-web/
├── tools/             cc1plus.js/.wasm, avr-as.js, avr-ld.js, objcopy.js, …
├── sysroot/           avr-libc + libgcc + headers (per board)
├── arduino-core/      Arduino core + variants
├── libraries/         Wire, SPI, EEPROM, SoftwareSerial
├── specs/             per-MCU driver argv
└── manifest.json      file catalog the pipeline fetches into MEMFS
```

## 2.  Build & run

```bash
cd examples/maui-avr-assembler

# iOS simulator (run from a Mac):
dotnet build -t:Run -f net9.0-ios

# Mac Catalyst:
dotnet build -t:Run -f net9.0-maccatalyst

# Android emulator:
dotnet build -t:Run -f net9.0-android
```

## How it works

1. `MainPage.xaml` declares a `HybridWebView` whose `HybridRoot` points
   at the `arduinowasm/` folder shipped under `Resources/Raw/`.  MAUI
   serves that folder over an internal `https://` origin to
   `WKWebView` / WebView.
2. When the user clicks **Compile**, `MainPage.xaml.cs` calls
   `HybridWebView.InvokeJavaScriptAsync<CompileResult>("compile", …)`
   with a `CompileRequest` carrying the source, the `-mmcu` value,
   the avr-libc arch family (`avr5`, `avr6`, `avr25`, …) and the name
   of the device CRT object (`crtatmega328p.o`, …).
3. `arduino-pipeline.js` fetches the bundle files listed in
   `dist-web/manifest.json` into MEMFS, then chains the WASM tools —
   `cc1plus` → `avr-as` → `avr-ld` → `objcopy` — to produce Intel HEX.
4. The HEX text is returned as JSON and rendered in the `OutputLabel`.
   While the link step is running, the linker prints progress through
   `HybridWebView.SendRawMessage`, which the C# side appends to the
   same label.

## Adding a new device

The `Devices` list in `MainPage.xaml.cs` mirrors
`src/avr-ld/devices.sh` (and the board table in
`tools/arduino-wasm/recipe.js`) in the parent repository.  When you add a
new entry there and rebuild the `dist-web` bundle, add the matching row
here:

```csharp
new("My Board (ATmegaXYZ)", "myboard"),
```

…and make sure the bundle includes that board's sysroot under
`Resources/Raw/arduinowasm/dist-web/sysroot/`.

## Troubleshooting

| Symptom                                        | Likely cause |
|------------------------------------------------|--------------|
| `Toolchain ready.` never appears               | The `dist-web/` bundle is missing under `Resources/Raw/arduinowasm/`. |
| `[ld] cannot find -lc`                         | The `dist-web/sysroot/avr/lib/<arch>/libc.a` for the selected board is missing. |
| `[ld] <crt>: No such file…`                    | The CRT object for the selected board is missing from the bundle sysroot. |
| Build error `HybridWebView is not defined`     | Ensure the project targets **.NET 9**; `HybridWebView` was added in .NET 9 MAUI. |

## License

This example app is licensed under the **MIT License** (see
[`LICENSE`](LICENSE)) — it is host code that drives the toolchain at arm's
length (argv + a virtual filesystem) and contains no GPL compiler code.
The downloaded `dist-web` toolchain blobs remain GPL-3.0-or-later; see
[`../../docs/LICENSING.md`](../../docs/LICENSING.md) for how the two coexist.
