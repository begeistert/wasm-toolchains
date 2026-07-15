#include <stdint.h>
#include "Common.h"     // real ArduinoCore-API: global pinMode/digitalWrite/millis decls
#define REG(a) (*(volatile uint32_t*)(a))
#define SIO 0xd0000000u
#define IO_BANK0 0x40014000u
static volatile uint32_t _ms = 0;
void pinMode(pin_size_t pin, PinMode m) {
    REG(IO_BANK0+0x004+8*pin) = 5;                // GPIO func = SIO
    if (m==OUTPUT) REG(SIO+0x024)=1u<<pin; else REG(SIO+0x028)=1u<<pin;
}
void digitalWrite(pin_size_t pin, PinStatus v) {
    if (v==HIGH) REG(SIO+0x014)=1u<<pin; else REG(SIO+0x018)=1u<<pin;
}
PinStatus digitalRead(pin_size_t pin){ return (REG(SIO+0x004)&(1u<<pin))?HIGH:LOW; }
unsigned long millis(void){ return _ms; }
unsigned long micros(void){ return _ms*1000u; }
void delay(unsigned long ms){ for(volatile unsigned long i=0;i<ms*1000u;i++) __asm__ volatile("nop"); _ms+=ms; }
void delayMicroseconds(unsigned int us){ for(volatile unsigned int i=0;i<us;i++) __asm__ volatile("nop"); }
