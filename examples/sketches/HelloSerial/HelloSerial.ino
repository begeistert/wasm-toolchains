// Real Arduino sketch used to validate the WASM toolchain end-to-end.
// Exercises the Arduino core (Serial/HardwareSerial, pinMode/digitalWrite,
// millis) so a successful compile proves the core links and runs.

const int led = 13;

void setup() {
  Serial.begin(9600);
  pinMode(led, OUTPUT);
  Serial.println("HELLO_AVR_WASM");
}

void loop() {
  digitalWrite(led, HIGH);
  delay(100);
  digitalWrite(led, LOW);
  delay(100);
  Serial.println("tick");
}
