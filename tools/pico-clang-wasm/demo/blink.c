/* Minimal bare-metal RP2040 blink — proves the permissive clang chain:
 * clang (frontend+integrated-as) -> lld -> picolibc (libc) + compiler-rt (builtins).
 * Toggles GP25 (the Pico's on-board LED) via the SIO GPIO registers. */
#include <stdint.h>
#include <string.h>   /* picolibc header */

#define SIO_BASE       0xd0000000u
#define GPIO_OE_SET   (*(volatile uint32_t *)(SIO_BASE + 0x024))
#define GPIO_OUT_XOR  (*(volatile uint32_t *)(SIO_BASE + 0x01c))
#define IO_BANK0_BASE  0x40014000u
#define GP25_CTRL     (*(volatile uint32_t *)(IO_BANK0_BASE + 0x0cc))
#define LED_PIN 25u

/* keep a compiler-rt builtin (__aeabi_uidiv) and a picolibc symbol (memset) live */
volatile uint32_t divisor = 3;

static void delay(volatile uint32_t n) { while (n--) __asm__ volatile("nop"); }

int main(void) {
    static uint8_t scratch[16];
    memset(scratch, 0, sizeof scratch);          /* picolibc */
    GP25_CTRL = 5;                                /* SIO function */
    GPIO_OE_SET = (1u << LED_PIN);
    for (;;) {
        GPIO_OUT_XOR = (1u << LED_PIN);
        uint32_t d = 500000u / divisor;           /* compiler-rt __aeabi_uidiv */
        delay(d + scratch[0]);
    }
    return 0;
}

/* --- minimal vector table + reset for a standalone Cortex-M image --- */
extern uint32_t __stack;
void _start(void);
void Reset_Handler(void) { main(); for(;;){} }
__attribute__((section(".vectors"), used))
void (* const vector_table[])(void) = {
    (void (*)(void))(&__stack),   /* initial SP */
    Reset_Handler,                /* reset */
    Reset_Handler, Reset_Handler, /* NMI, HardFault */
};
