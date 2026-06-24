// HeavyDemo — a heavier sketch to stress the WASM toolchain: three libraries
// (Wire/SPI/SoftwareSerial), call-before-definition (exercises prototype
// generation), floating point, and a lookup table.
#include <Wire.h>
#include <SPI.h>
#include <SoftwareSerial.h>

SoftwareSerial soft(10, 11);

const float coeffs[8] = { 1.0, 0.5, 0.25, 0.125, 2.0, 4.0, 8.0, 16.0 };

void setup() {
  Serial.begin(9600);
  Wire.begin();
  SPI.begin();
  soft.begin(4800);

  // Called before they are defined below — only works if prototypes are
  // generated during .ino preprocessing.
  int s = checksum();
  float w = weighted(3.0);

  Serial.print("SUM=");
  Serial.println(s);
  Serial.print("W=");
  Serial.println(w);
  Serial.println("HEAVY_OK");
}

void loop() {}

int checksum() {
  int total = 0;
  for (int i = 0; i < 8; i++) total += (int)(coeffs[i] * 10.0);
  return total;
}

float weighted(float x) {
  float acc = 0;
  for (int i = 0; i < 8; i++) acc += coeffs[i] * x;
  return acc;
}
