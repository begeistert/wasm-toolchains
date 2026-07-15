MEMORY {
  FLASH (rx)  : ORIGIN = 0x10000000, LENGTH = 2048K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 264K
}
ENTRY(Reset_Handler)
SECTIONS {
  .boot2   0x10000000 : { KEEP(*(.boot2)) } > FLASH
  .vectors 0x10000100 : { KEEP(*(.vectors)) } > FLASH
  .text : { *(.text*) *(.rodata*) *(.glue_7*) } > FLASH
  . = ALIGN(4); __etext = .;
  .data : AT(__etext) { __data_start__ = .; *(.data*) ; __data_end__ = .; } > RAM
  .bss  : { __bss_start__ = .; *(.bss*) *(COMMON) ; __bss_end__ = .; } > RAM
  . = ALIGN(8); __end__ = .;
  __heap_start = __end__;
  __heap_end   = ORIGIN(RAM) + LENGTH(RAM) - 0x2000;   /* 8 KB reserved for stack */
  __stack_top  = ORIGIN(RAM) + LENGTH(RAM);
}
