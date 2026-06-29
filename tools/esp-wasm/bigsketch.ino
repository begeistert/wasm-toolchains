// bigsketch.ino — reference "kitchen-sink" sketch for the ESP32 bundle harvest.
// The bundle ships exactly the header closure + link objects this sketch pulls in,
// so it must EXERCISE everything a user sketch might need. For ESP32 that means the
// wireless/networking + BLE core libraries (the whole point of the chip) on top of
// the cross-platform Tier-1 sensor libs. A user sketch using any subset then
// compiles + links on-device (--gc-sections drops the unused).
//
// WiFi/BLE/networking headers come from the arduino-esp32 CORE (no extra lib
// install); SPI/Wire/EEPROM too. Servo is intentionally absent (no arduino-esp32
// Servo lib — see the comment history). The Tier-1 Adafruit/DHT/Keypad libs are the
// pinned installs in src/espcap.
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiServer.h>
#include <WiFiUdp.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <esp_now.h>
#include <Preferences.h>
#include <FS.h>
#include <SPIFFS.h>
#include <LittleFS.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include <SPI.h>
#include <Wire.h>
#include <EEPROM.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_PWMServoDriver.h>
#include <Adafruit_MCP9808.h>
#include <Keypad.h>
#include <math.h>

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// Wireless / networking
WiFiServer server(80);
WiFiUDP udp;
WiFiClient client;
WiFiClientSecure tls;
HTTPClient http;

// BLE
BLEServer *bleServer = nullptr;

// Tier-1 sensors / IO
Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);
DHT dht(7, DHT22);
Adafruit_PWMServoDriver pwm;
Adafruit_MCP9808 mcp;
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
byte rowPins[ROWS] = {9,8,7,6}, colPins[COLS] = {5,4,3,2};
Keypad kp(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
Preferences prefs;

void setup() {
  Serial.begin(115200);
  SPI.begin(); Wire.begin(); EEPROM.begin(512);
  strip.begin(); strip.show(); dht.begin(); pwm.begin(); mcp.begin();
  pinMode(LED_BUILTIN, OUTPUT);

  WiFi.mode(WIFI_STA);
  WiFi.begin("ssid", "pass");
  server.begin();
  udp.begin(1234);
  MDNS.begin("esp32");
  esp_now_init();

  prefs.begin("app", false);
  SPIFFS.begin(true); LittleFS.begin(true);

  BLEDevice::init("esp32");
  bleServer = BLEDevice::createServer();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (http.begin(client, "http://example.com/")) { http.GET(); http.end(); }
    WiFiClient c = server.available();
    int n = udp.parsePacket(); (void)n;
  }
  strip.setPixelColor(0, strip.Color(10, 20, 30)); strip.show();
  float t = dht.readTemperature(); pwm.setPWM(0, 0, (int)(t * 10) % 4096);
  float m = mcp.readTempC(); char k = kp.getKey();
  uint8_t v = EEPROM.read(0); EEPROM.write(0, v + 1); EEPROM.commit();
  prefs.putUInt("n", v);
  Serial.println(sinf(millis() * 0.001f) + t + m + k, 4);
  digitalWrite(LED_BUILTIN, v & 1); delay(100);
}
