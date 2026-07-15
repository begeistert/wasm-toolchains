#pragma once
#include "Print.h"
struct UartSerial : public arduino::Print {
    void begin(unsigned long){}
    size_t write(uint8_t c) override {
        volatile uint32_t* dr=(volatile uint32_t*)0x40034000u;
        volatile uint32_t* fr=(volatile uint32_t*)0x40034018u;
        while(*fr & (1u<<5)) {}   // TXFF
        *dr=c; return 1;
    }
    using arduino::Print::write;
};
