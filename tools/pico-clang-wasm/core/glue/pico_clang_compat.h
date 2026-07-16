/* pico_clang_compat.h — force-included shim for building the pico-sdk with a
 * stock clang (not the LLVM-embedded-toolchain-for-Arm). clang reports
 * __has_builtin(__wfe/__sev/__wfi/__sevl) == true (ACLE), so the SDK's
 * hardware/sync.h skips its inline fallback — but those ACLE intrinsics require
 * <arm_acle.h>, which the SDK never includes. Define exactly those (and nothing
 * the SDK already defines, e.g. __nop/__dmb/__dsb/__isb) as inline asm. */
#pragma once
#if defined(__clang__) && defined(__arm__) && !defined(__riscv)
#define _PICO_CLANG_INTRIN static __inline__ __attribute__((always_inline, unused))
_PICO_CLANG_INTRIN void __wfe(void)  { __asm__ volatile ("wfe" ::: "memory"); }
_PICO_CLANG_INTRIN void __sev(void)  { __asm__ volatile ("sev"); }
_PICO_CLANG_INTRIN void __wfi(void)  { __asm__ volatile ("wfi" ::: "memory"); }
_PICO_CLANG_INTRIN void __sevl(void) { __asm__ volatile ("sevl"); }
#endif
