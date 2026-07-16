#include <stdint.h>
#include "Common.h"          // pinMode/digitalWrite/millis (global)
#include "String.h"          // arduino::String
#include "UartSerial.h"      // Print subclass over UART0
using arduino::String;
#define LED_BUILTIN 25
UartSerial Serial;
static int count=0;
extern "C" int main(void){
    pinMode(LED_BUILTIN, OUTPUT);
    Serial.begin(115200);
    Serial.println("clang arduino-pico core: boot ok");
    for(;;){
        digitalWrite(LED_BUILTIN, HIGH); delay(250);
        digitalWrite(LED_BUILTIN, LOW);  delay(250);
        String msg = String("blink #") + String(count++) + " @" + String(millis()) + "ms";
        Serial.println(msg);                 // real ArduinoCore-API String + Print
    }
}
