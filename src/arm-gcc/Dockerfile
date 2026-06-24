# Build cc1/cc1plus + binutils (arm-none-eabi, GCC 14.3.0) to WebAssembly for
# on-device RP2040 / Pico compiling. Same infra as src/avr-gcc, target=arm.
FROM emscripten/emsdk:4.0.22 AS builder

ARG GCC_VER=14.3.0
ARG BINUTILS_BRANCH=binutils-2_43-branch
ARG GMP_VER=6.3.0
ARG MPFR_VER=4.2.1
ARG MPC_VER=1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl xz-utils bzip2 bison flex texinfo make gcc g++ \
        libgmp-dev libmpfr-dev libmpc-dev && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /deps
RUN curl -fsSL https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VER}.tar.xz   | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpfr/mpfr-${MPFR_VER}.tar.xz | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpc/mpc-${MPC_VER}.tar.gz    | tar xz

RUN mkdir -p /src && \
    curl -fsSL https://ftp.gnu.org/gnu/gcc/gcc-${GCC_VER}/gcc-${GCC_VER}.tar.xz \
      | tar xJ -C /src --strip-components=1

RUN git clone --depth 1 --branch ${BINUTILS_BRANCH} \
      git://sourceware.org/git/binutils-gdb.git /src-binutils

WORKDIR /src
COPY ./build.sh /build.sh
RUN chmod +x /build.sh && \
    GMP_VER=${GMP_VER} MPFR_VER=${MPFR_VER} MPC_VER=${MPC_VER} /build.sh /dist

FROM scratch AS export
COPY --from=builder /dist/ /
