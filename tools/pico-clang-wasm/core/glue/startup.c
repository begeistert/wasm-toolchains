#include <stdint.h>
extern uint32_t __data_start__, __data_end__, __etext, __bss_start__, __bss_end__, __stack_top;
extern int main(void);
void Reset_Handler(void) {
    for (uint32_t *s=&__etext,*d=&__data_start__; d<&__data_end__;) *d++=*s++;
    for (uint32_t *b=&__bss_start__; b<&__bss_end__;) *b++=0;
    (void)main();
    for(;;){}
}
void Default_Handler(void){for(;;){}}
__attribute__((section(".vectors"),used))
void (* const vtable[])(void) = {
    (void(*)(void))&__stack_top, Reset_Handler,
    Default_Handler, Default_Handler, Default_Handler, Default_Handler,
    Default_Handler, 0,0,0, Default_Handler, Default_Handler, 0, Default_Handler, Default_Handler,
};
