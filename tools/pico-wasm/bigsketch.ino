// bigsketch.ino — reference "kitchen-sink" sketch for the Pico bundle harvest.
// It #includes every Tier-1 library (the ones iCircuit reimplements as C# shims)
// and instantiates each, so the harvest captures their headers into the closure
// and their compiled objects into the link. Any user sketch that uses a subset of
// these libraries then compiles + links on-device (--gc-sections drops the unused).
#include <SPI.h>
#include <Wire.h>
#include <EEPROM.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_PWMServoDriver.h>
#include <Adafruit_MCP9808.h>
#include <Keypad.h>
#include <Servo.h>
#include <math.h>

Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);
DHT dht(7, DHT22);
Adafruit_PWMServoDriver pwm;
Adafruit_MCP9808 mcp;
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
byte rowPins[ROWS] = {9,8,7,6}, colPins[COLS] = {5,4,3,2};
Keypad kp(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
Servo servo;

void setup() {
  Serial.begin(115200); SPI.begin(); Wire.begin(); EEPROM.begin(512);
  strip.begin(); strip.show(); dht.begin(); pwm.begin(); mcp.begin(); servo.attach(10);
  pinMode(LED_BUILTIN, OUTPUT);
}
void loop() {
  strip.setPixelColor(0, strip.Color(10, 20, 30)); strip.show();
  float t = dht.readTemperature(); pwm.setPWM(0, 0, (int)(t * 10) % 4096);
  float m = mcp.readTempC(); char k = kp.getKey(); servo.write((int)(m + k) % 180);
  uint8_t v = EEPROM.read(0); EEPROM.write(0, v + 1); EEPROM.commit();
  Serial.println(sinf(millis() * 0.001f) + t + m, 4); digitalWrite(LED_BUILTIN, v & 1); delay(100);
}
