# Build the Espressif GCC cross-compilers (cc1/cc1plus/lto1) + binutils to
# WebAssembly, for on-device ESP32 compiling. ONE parametrized context builds
# both chips — pass TARGET + (for Xtensa) XTENSA_OVERLAY:
#
#   ESP32-C3 (RISC-V): --build-arg TARGET=riscv32-esp-elf
#   ESP32   (Xtensa) : --build-arg TARGET=xtensa-esp-elf --build-arg XTENSA_OVERLAY=esp32
#
# Same infra as src/arm-gcc, but sourced from the Espressif gcc/binutils forks so
# the produced objects are ABI-compatible with arduino-esp32's precompiled core
# (harvested by src/espcap). Xtensa has no upstream esp32 config, hence the fork +
# the xtensa-overlays config (XTENSA_GNU_CONFIG); RISC-V is closer to upstream but
# we still use the fork to match the shipped multilibs.
#
# NOTE: heavy (~hours) and CI-validated (release-esp.yml, gha-cached). The Xtensa
# overlay wiring in particular may need tuning to the pinned fork branch.
FROM emscripten/emsdk:4.0.22 AS builder

ARG TARGET=riscv32-esp-elf
ARG XTENSA_OVERLAY=
# Espressif fork refs; pin to the toolchain release that matches arduino-esp32's
# core (3.1.1 → the 2405 train, gcc 13.2.0 / binutils 2.41.0). Overridden per chip
# by the CI matrix. binutils is published as esp-<ver>_<date> tags.
ARG GCC_BRANCH=esp-13.2.0_20240530
ARG BINUTILS_BRANCH=esp-2.41.0_20240530
ARG GMP_VER=6.3.0
ARG MPFR_VER=4.2.1
ARG MPC_VER=1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl xz-utils bzip2 bison flex texinfo make gcc g++ \
        libgmp-dev libmpfr-dev libmpc-dev python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /deps
RUN curl -fsSL https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VER}.tar.xz   | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpfr/mpfr-${MPFR_VER}.tar.xz | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpc/mpc-${MPC_VER}.tar.gz    | tar xz

# Espressif gcc + binutils forks (shallow). Xtensa overlay only when building Xtensa.
RUN git clone --depth 1 --branch ${GCC_BRANCH}      https://github.com/espressif/gcc.git          /src && \
    git clone --depth 1 --branch ${BINUTILS_BRANCH} https://github.com/espressif/binutils-gdb.git /src-binutils && \
    if [ -n "${XTENSA_OVERLAY}" ]; then \
      git clone --depth 1 https://github.com/espressif/xtensa-overlays.git /src-overlays; fi

WORKDIR /src
COPY ./build.sh /build.sh
RUN chmod +x /build.sh && \
    TARGET=${TARGET} XTENSA_OVERLAY=${XTENSA_OVERLAY} \
    GMP_VER=${GMP_VER} MPFR_VER=${MPFR_VER} MPC_VER=${MPC_VER} /build.sh /dist

FROM scratch AS export
COPY --from=builder /dist/ /
