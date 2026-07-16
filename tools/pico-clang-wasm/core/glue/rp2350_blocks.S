// RP2350 IMAGE_DEF block loop, clang-assembled from pico-sdk sources (BSD) — the
// exact bytes pico_crt0 emits for an Arm-Secure flash image: a .embedded_block
// (IMAGE_TYPE item, marker 0xffffded3) near the start + a .embedded_end_block at
// flash end, forming the single block loop the RP2350 bootrom scans (first 4 KB).
#include "pico.h"
#include "boot/picobin.h"
#include "embedded_start_block.inc.S"
#include "embedded_end_block.inc.S"
