// Arduino.h — the umbrella the sketch includes. Pulls the REAL ArduinoCore-API
// classes (Print/Stream/String/Common) and declares the arduino-pico platform
// API (pinMode/digitalWrite/millis/...) implemented in wiring.cpp over pico-sdk.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "api/Common.h"      // real ArduinoCore-API: pinMode/digital enums live here
#include "api/Print.h"
#include "api/Stream.h"
#include "api/String.h"
#include "api/Printable.h"
using namespace arduino;      // arduino-pico brings the api namespace into scope

#ifndef LED_BUILTIN
#define LED_BUILTIN 25        // Pico on-board LED (GP25). pico2 also GP25.
#endif

#include "ArduinoSerial.h"
extern ArduinoSerial Serial;  // UART0 on GP0/GP1, like arduino-pico Serial1

void initArduino();
