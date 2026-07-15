MEMORY {
  FLASH (rx) : ORIGIN = 0x10000000, LENGTH = 2048K
  RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 264K
}
ENTRY(Reset_Handler)
SECTIONS {
  .text : {
    KEEP(*(.vectors))
    *(.text*) *(.rodata*)
  } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss  : { *(.bss*) *(COMMON) } > RAM
  __stack = ORIGIN(RAM) + LENGTH(RAM);
}
