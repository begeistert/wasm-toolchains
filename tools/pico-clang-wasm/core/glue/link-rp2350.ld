MEMORY {
  FLASH (rx)  : ORIGIN = 0x10000000, LENGTH = 2048K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 512K
}
ENTRY(Reset_Handler)
SECTIONS {
  .flashstart 0x10000000 : {
    __logical_binary_start = .;
    KEEP(*(.vectors))
    KEEP(*(.embedded_block))
    __embedded_block_end = .;
  } > FLASH
  .text : { *(.text*) *(.rodata*) *(.glue_7*) } > FLASH
  .embedded_end_block : { KEEP(*(.embedded_end_block)) } > FLASH
  . = ALIGN(4); __etext = .;
  .data : AT(__etext) { __data_start__ = .; *(.data*) ; __data_end__ = .; } > RAM
  .bss  : { __bss_start__ = .; *(.bss*) *(COMMON) ; __bss_end__ = .; } > RAM
  . = ALIGN(8); __end__ = .;
  __heap_start = __end__;
  __heap_end   = ORIGIN(RAM) + LENGTH(RAM) - 0x2000;
  __stack_top  = ORIGIN(RAM) + LENGTH(RAM);
  ASSERT(__embedded_block_end - __logical_binary_start <= 4096, "block must be in first 4 KB")
}
