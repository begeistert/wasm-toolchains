using System.Text.Json;

namespace MauiAvrAssembler;

/// <summary>
/// Bridges the MAUI UI to the JavaScript AVR toolchain hosted inside a
/// <see cref="HybridWebView"/>.  The web view loads <c>arduinowasm/index.html</c>
/// (shipped under <c>Resources/Raw/arduinowasm/</c>), which in turn loads the
/// emscripten-built compiler modules (<c>cc1plus.js</c>, <c>avr-as.js</c>,
/// <c>avr-ld.js</c>, <c>objcopy.js</c>, …) plus the trimmed sysroot.  The user
/// enters an Arduino sketch, picks a target board, and we round-trip:
///
///     C# source string ──► JS pipeline ──► .o ──► .elf ──► Intel HEX ──► C# UI
///
/// On iOS this runs entirely inside <c>WKWebView</c>, with no native code
/// other than MAUI itself, so the pipeline works on a real device or in
/// the simulator without any extra entitlements.
/// </summary>
public partial class MainPage : ContentPage
{
    /// <summary>
    /// Devices supported by the bundled avr-ld build.  MUST stay in sync
    /// with <c>src/avr-ld/devices.sh</c> in the wasm-toolchains repository.
    /// </summary>
    private static readonly DeviceInfo[] Devices =
    [
        new("Arduino Uno (ATmega328P)",  "uno"),
        new("Arduino Nano (ATmega328P)", "nano"),
        new("Arduino Mega (ATmega2560)", "mega"),
    ];

    private bool _toolchainReady;

    public MainPage()
    {
        InitializeComponent();

        DevicePicker.ItemsSource = Devices.Select(d => d.Label).ToList();
        DevicePicker.SelectedIndex = 0;
        CompileButton.IsEnabled = true;
        OutputLabel.Text = "Starting HybridWebView runtime…\n\nLoading index.html…";

        // If no raw message arrives, keep the UI usable and surface a hint.
        Dispatcher.DispatchDelayed(TimeSpan.FromSeconds(5), () =>
        {
            if (!_toolchainReady && !BusyIndicator.IsRunning)
            {
                OutputLabel.Text =
                    "Starting HybridWebView runtime…\n(no ready signal after 5s; press Compile to force diagnostics)";
            }
        });

        SourceEditor.Text =
            """
            const int led = 13;
            void setup() {
              Serial.begin(9600);
              pinMode(led, OUTPUT);
              Serial.println("HELLO_AVR_WASM");
            }
            void loop() {
              digitalWrite(led, HIGH); delay(100);
              digitalWrite(led, LOW);  delay(100);
            }
            """;
    }

    private async void OnCompileClicked(object? sender, EventArgs e)
    {
        if (DevicePicker.SelectedIndex < 0)
        {
            return;
        }

        var device = Devices[DevicePicker.SelectedIndex];

        SetBusy(true);
        try
        {
            // Drive the compile through the native WKWebView (the MAUI
            // HybridWebView message bridge does not deliver on this target;
            // WKWebView.EvaluateJavaScript is a reliable separate channel).
            var result = await CompileViaWebKit(SourceEditor.Text ?? string.Empty, device.Board)
                ?? new CompileResult(false, null, "JS pipeline returned null");

            OutputLabel.Text = result.Ok
                ? $"✅ {result.Hex!.Split('\n').Length - 1} lines of Intel HEX compiled in WebKit\n\n{result.Hex}"
                : $"❌ Compilation failed:\n\n{result.Log ?? "(no diagnostics)"}";
        }
        catch (Exception ex)
        {
            OutputLabel.Text = $"❌ Host error: {ex.Message}";
        }
        finally
        {
            SetBusy(false);
        }
    }

    /// <summary>
    /// Compiles a sketch by driving the WASM toolchain inside the native
    /// WKWebView via EvaluateJavaScript: waits for the toolchain to load,
    /// kicks off window.compile, and polls window.__result. Returns null only
    /// if the native web view can't be reached.
    /// </summary>
    private async Task<CompileResult?> CompileViaWebKit(string source, string board)
    {
#if MACCATALYST || IOS
        var wk = ToolHost.Handler?.PlatformView as WebKit.WKWebView;
        if (wk is null) return new CompileResult(false, null, "native WKWebView not available");

        async Task<string> Eval(string js)
        {
            var tcs = new TaskCompletionSource<string>();
            Dispatcher.Dispatch(async () =>
            {
                try { var r = await wk.EvaluateJavaScriptAsync(js); tcs.TrySetResult(r?.ToString() ?? ""); }
                catch (Exception ex) { tcs.TrySetResult("EVAL-ERR:" + ex.Message); }
            });
            return await tcs.Task;
        }

        for (var t = 0; t < 90; t++)   // wait for the toolchain to finish loading
        {
            var ph = await Eval("window.__phase || 'no-page'");
            if (ph == "ready") break;
            if (ph == "init-failed" || ph.StartsWith("EVAL-ERR"))
                return new CompileResult(false, null, "load " + ph + ": " + await Eval("window.__err||''"));
            await Task.Delay(1000);
        }

        var srcJson = System.Text.Json.JsonSerializer.Serialize(source, JsonContext.Default.String);
        await Eval(
            "window.__result='';" +
            $"window.compile({{source:{srcJson},board:'{board}'}})" +
            ".then(r=>window.__result=JSON.stringify({ok:r.ok,hex:r.hex,log:r.log}))" +
            ".catch(e=>window.__result=JSON.stringify({ok:false,hex:null,log:String(e)}));'go'");

        for (var t = 0; t < 300; t++)
        {
            await Task.Delay(1000);
            var r = await Eval("window.__result || ''");
            if (!string.IsNullOrEmpty(r))
                return System.Text.Json.JsonSerializer.Deserialize(r, JsonContext.Default.CompileResult);
        }
        return new CompileResult(false, null, "compile timed out");
#else
        await Task.CompletedTask;
        return new CompileResult(false, null, "unsupported platform");
#endif
    }

    // The Mac Catalyst sandbox denies writes to the system /tmp; write into the
    // app's own temp dir (Path.GetTempPath() -> the container, readable from
    // ~/Library/Containers/com.avrwasm.example.assembler/Data/tmp/).
    private static readonly string LogPath =
        Path.Combine(Path.GetTempPath(), "arduino-wasm-log.txt");
    private static readonly string ResultPath =
        Path.Combine(Path.GetTempPath(), "arduino-wasm-maccat.txt");

    private void AppendLog(string line)
    {
        // Mirror every diagnostic to a file so it can be read from the console
        // (HybridWebView raw messages otherwise only reach the UI).
        try { File.AppendAllText(LogPath, line + "\n"); } catch { }
        Dispatcher.Dispatch(() =>
        {
            OutputLabel.Text = string.IsNullOrEmpty(OutputLabel.Text)
                ? line
                : $"{OutputLabel.Text}\n{line}";
        });
    }

    /// <summary>
    /// HybridWebView raises this every time the JS side calls
    /// <c>HybridWebView.SendRawMessage(text)</c>.  We use it as a one-way
    /// channel for streaming progress / log output from the linker.
    /// </summary>
    private void OnHybridRawMessage(object? sender, HybridWebViewRawMessageReceivedEventArgs e)
    {
        if (string.IsNullOrEmpty(e.Message))
        {
            return;
        }

        // Marshal back to the UI thread; HybridWebView events on iOS may
        // arrive on a non-UI dispatcher.
        Dispatcher.Dispatch(() =>
        {
            if (e.Message.Contains("__TOOLCHAIN_READY__", StringComparison.Ordinal))
            {
                _toolchainReady = true;
                StartSelfTestOnce();
            }

            AppendLog(e.Message);
        });
    }

    private bool _selfTestStarted;

    protected override void OnAppearing()
    {
        base.OnAppearing();
        // Trigger the headless self-test a few seconds after the page has had
        // time to load — independent of the SendRawMessage channel (JS→C#),
        // which may not deliver. InvokeJavaScriptAsync (C#→JS) is a separate
        // path; window.compile waits internally for the toolchain to be ready.
        Dispatcher.DispatchDelayed(TimeSpan.FromSeconds(6), StartSelfTestOnce);
    }

    private void StartSelfTestOnce()
    {
        if (_selfTestStarted) return;
        _selfTestStarted = true;
        _ = RunHeadlessSelfTest();
    }

    /// <summary>
    /// Compiles the current sketch through the WASM toolchain running inside
    /// WKWebView/JavaScriptCore and writes a one-line verdict + the HEX to
    /// <c>/tmp/arduino-wasm-maccat.txt</c>. This is the console-readable proof
    /// that the pipeline runs in real WebKit (not just Node/V8).
    /// </summary>
    private async Task RunHeadlessSelfTest()
    {
        var outPath = ResultPath;
        var sb = new System.Text.StringBuilder();
        void Log(string s)
        {
            sb.AppendLine($"[{DateTime.Now:HH:mm:ss}] {s}");
            try { File.WriteAllText(outPath, sb.ToString()); } catch { }
        }
        Log("SELFTEST STARTING (native WKWebView EvaluateJavaScript)");

#if MACCATALYST || IOS
        var wk = ToolHost.Handler?.PlatformView as WebKit.WKWebView;
        if (wk is null)
        {
            Log("ERROR: native WKWebView not found (PlatformView=" +
                (ToolHost.Handler?.PlatformView?.GetType().FullName ?? "null") + ")");
            return;
        }

        // EvaluateJavaScript must run on the UI thread; marshal each call.
        async Task<string> Eval(string js)
        {
            var tcs = new TaskCompletionSource<string>();
            Dispatcher.Dispatch(async () =>
            {
                try { var r = await wk.EvaluateJavaScriptAsync(js); tcs.TrySetResult(r?.ToString() ?? ""); }
                catch (Exception ex) { tcs.TrySetResult("EVAL-ERR:" + ex.Message); }
            });
            return await tcs.Task;
        }

        // 1. Watch the loading phase until ready / failed.
        string last = "";
        for (var t = 0; t < 90; t++)
        {
            var ph = await Eval("window.__phase || 'no-page'");
            if (ph != last) { Log("phase=" + ph); last = ph; }
            if (ph == "ready" || ph == "init-failed" || ph.StartsWith("EVAL-ERR")) break;
            await Task.Delay(1000);
        }
        Log("err=" + await Eval("window.__err || ''"));
        Log("factories=" + await Eval("JSON.stringify(window.__factories?Object.keys(window.__factories):[])"));

        // 2. Kick off the compile, then poll window.__result.
        Log("kick: " + await Eval("window.runSelfTest ? window.runSelfTest() : 'no-runSelfTest'"));
        string resultJson = "";
        for (var t = 0; t < 300; t++)   // up to ~5 min
        {
            await Task.Delay(1000);
            var r = await Eval("window.__result || ''");
            if (t % 5 == 0) Log("t=" + t + "s phase=" + await Eval("window.__phase||''"));
            if (!string.IsNullOrEmpty(r)) { resultJson = r; break; }
        }
        if (string.IsNullOrEmpty(resultJson))
        {
            Log("TIMEOUT — no result; final phase=" + await Eval("window.__phase||''"));
            return;
        }

        try
        {
            var res = System.Text.Json.JsonSerializer.Deserialize(resultJson, JsonContext.Default.CompileResult);
            var ok = res?.Ok == true && !string.IsNullOrEmpty(res.Hex);
            Log(ok
                ? $"SELFTEST PASS — {res!.Hex!.Split('\n').Length - 1} HEX lines compiled in WebKit"
                : $"SELFTEST FAIL — {res?.Log ?? "(null)"}");
            if (ok) { sb.AppendLine(res!.Hex); try { File.WriteAllText(outPath, sb.ToString()); } catch { } }
            Dispatcher.Dispatch(() => OutputLabel.Text = ok ? "✅ Compiled in WebKit" : "❌ Compile failed");
        }
        catch (Exception ex)
        {
            Log("parse err: " + ex.Message + " | raw=" + resultJson[..Math.Min(200, resultJson.Length)]);
        }
#else
        Log("not a Mac Catalyst / iOS target");
        await Task.CompletedTask;
#endif
    }

    private void SetBusy(bool busy, string? statusText = null)
    {
        BusyIndicator.IsRunning = busy;
        BusyIndicator.IsVisible = busy;
        CompileButton.IsEnabled = !busy;
        if (busy && statusText is not null)
        {
            OutputLabel.Text = statusText;
        }
    }

    private sealed record DeviceInfo(string Label, string Board);
}
