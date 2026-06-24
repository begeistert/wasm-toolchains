#!/bin/bash
# Supported AVR devices for avr-ld
#
# This file is the single source of truth for which chips are compiled into
# the avr-ld.js bundle.  Edit it to add or remove devices.
#
# Format: LABEL:MCU:AVR_ARCH_FAMILY:CRT_OBJ
#   LABEL           Human-readable name used in docs and device info
#   MCU             MCU identifier used by avr-as (-mmcu) and avr-libc
#   AVR_ARCH_FAMILY avr-libc architecture family (subdirectory under /usr/lib/avr/lib/)
#   CRT_OBJ         Device-specific startup object file (crt<mcu>.o)
#
# Full device reference:
#   https://avrdudes.github.io/avr-libc/avr-libc-user-manual/index.html
#
# To add a new device:
#   1. Look up its MCU name in the avr-libc manual (column "Device").
#   2. Find its architecture family (column "AVR arch") and map it:
#        avr1 → avr1   avr2 → avr2   avr25 → avr25  avr3 → avr3
#        avr31 → avr31  avr35 → avr35  avr4 → avr4   avr5 → avr5
#        avr51 → avr51  avr6 → avr6   avrxmega* → avrxmega*  avrtiny → avrtiny
#   3. Confirm the CRT object exists:  ls /usr/lib/avr/lib/<family>/crt<mcu>.o
#   4. Append a new entry below following the same format.
#
DEVICES=(
  "arduino-uno:atmega328p:avr5:crtatmega328p.o"
  "arduino-nano:atmega328p:avr5:crtatmega328p.o"
  "arduino-mega:atmega2560:avr6:crtatmega2560.o"
  "attiny85:attiny85:avr25:crtattiny85.o"
)
