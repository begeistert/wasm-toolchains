// Freestanding C++ allocation operators over picolibc malloc/free (arduino-pico
// relies on libstdc++ for these; we supply them since we link no libc++/libstdc++).
#include <stdlib.h>
void* operator new(unsigned int n)   { return malloc(n ? n : 1); }
void* operator new[](unsigned int n) { return malloc(n ? n : 1); }
void  operator delete(void* p)         noexcept { free(p); }
void  operator delete[](void* p)       noexcept { free(p); }
void  operator delete(void* p, unsigned int)   noexcept { free(p); }
void  operator delete[](void* p, unsigned int) noexcept { free(p); }
extern "C" void __cxa_pure_virtual() { for(;;){} }
