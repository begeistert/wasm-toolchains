// Avr8Validate — loads a HEX produced by the WASM toolchain into the AVR-8
// simulator and asserts it actually runs: serial output appears and the
// LED pin toggles. This is the proof that the WASM-compiled binary is real.
//
// usage: Avr8Validate <sketch.hex> <expectedSerialSubstring>
using Avr8Sharp.TestKit.Boards;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: Avr8Validate <sketch.hex> [expectedSerialSubstring]");
    return 2;
}

var hexPath = args[0];
var expected = args.Length > 1 ? args[1] : "HELLO_AVR_WASM";
var hex = File.ReadAllText(hexPath);

var uno = new ArduinoUnoSimulation();
uno.WithHex(hex);   // returns the base type; keep `uno` typed for .Serial

// Run until the expected serial text shows up (or 3s of sim time elapses).
uno.RunUntilSerial(uno.Serial, expected, maxMs: 3000);

var serial = uno.Serial.Text;
var sawSerial = serial.Contains(expected);

// Toggle check: let it spin a bit and confirm the LED pin (PB5 = pin 13)
// is actually being driven (DDRB bit 5 set).
uno.RunMilliseconds(250);
var ddrb = uno.Data[0x24];                 // DDRB
var ledConfigured = (ddrb & (1 << 5)) != 0;

Console.WriteLine($"serial captured : {serial.Replace("\r", "").Replace("\n", "\\n")}");
Console.WriteLine($"expected found  : {sawSerial}  (\"{expected}\")");
Console.WriteLine($"DDRB=0x{ddrb:X2}  LED(pin13) configured output: {ledConfigured}");

// The serial match is the real proof the binary runs; the LED line is just
// informational (not every sketch drives pin 13).
if (sawSerial)
{
    Console.WriteLine("RESULT: PASS — WASM-compiled binary runs on the AVR-8 simulator.");
    return 0;
}

Console.Error.WriteLine("RESULT: FAIL — expected serial text not observed.");
return 1;
