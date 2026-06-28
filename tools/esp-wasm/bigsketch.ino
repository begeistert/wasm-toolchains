// bigsketch.ino — reference "kitchen-sink" sketch for the ESP32 bundle harvest.
// Same idea as tools/pico-wasm/bigsketch.ino (pull every Tier-1 library's headers
// into the closure + their objects into the link), but trimmed to what compiles on
// arduino-esp32: Servo is dropped — it's an AVR/RP2040-core library, not part of
// arduino-esp32 (ESP32 uses the separate ESP32Servo / LEDC instead). SPI/Wire/
// EEPROM come from the esp32 core; the rest are the cross-platform Tier-1 libs in
// src/espcap. Any user sketch using a subset compiles + links (--gc-sections drops
// the unused).
#include <SPI.h>
#include <Wire.h>
#include <EEPROM.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_PWMServoDriver.h>
#include <Adafruit_MCP9808.h>
#include <Keypad.h>
#include <math.h>

// The generic ESP32 Dev Module variant doesn't define LED_BUILTIN; fall back so
// the harvest sketch compiles on any board (real boards that define it keep it).
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);
DHT dht(7, DHT22);
Adafruit_PWMServoDriver pwm;
Adafruit_MCP9808 mcp;
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
byte rowPins[ROWS] = {9,8,7,6}, colPins[COLS] = {5,4,3,2};
Keypad kp(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

void setup() {
  Serial.begin(115200); SPI.begin(); Wire.begin(); EEPROM.begin(512);
  strip.begin(); strip.show(); dht.begin(); pwm.begin(); mcp.begin();
  pinMode(LED_BUILTIN, OUTPUT);
}
void loop() {
  strip.setPixelColor(0, strip.Color(10, 20, 30)); strip.show();
  float t = dht.readTemperature(); pwm.setPWM(0, 0, (int)(t * 10) % 4096);
  float m = mcp.readTempC(); char k = kp.getKey();
  uint8_t v = EEPROM.read(0); EEPROM.write(0, v + 1); EEPROM.commit();
  Serial.println(sinf(millis() * 0.001f) + t + m + k, 4); digitalWrite(LED_BUILTIN, v & 1); delay(100);
}
