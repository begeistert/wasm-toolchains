# Build cc1 / cc1plus (the AVR C/C++ compilers proper) to WebAssembly,
# plus a target sidecar (avr-libc, libgcc.a, headers) for the link step.
FROM emscripten/emsdk:4.0.22 AS builder

ARG GCC_VER=15.2.0
ARG GMP_VER=6.3.0
ARG MPFR_VER=4.2.1
ARG MPC_VER=1.3.1

# Build tooling + a NATIVE avr toolchain.  The native gcc-avr/avr-libc are
# only mined for their target runtime (libgcc.a, libc.a, crt*.o, headers)
# which ship as the sidecar; we never run them, we cross-build our own
# cc1plus from pristine GCC sources below.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git ca-certificates curl xz-utils bzip2 \
        bison flex texinfo make \
        gcc g++ \
        libgmp-dev libmpfr-dev libmpc-dev \
        avr-libc binutils-avr && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# GMP / MPFR / MPC sources (cross-compiled to wasm32 in build.sh).
WORKDIR /deps
RUN curl -fsSL https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VER}.tar.xz   | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpfr/mpfr-${MPFR_VER}.tar.xz | tar xJ && \
    curl -fsSL https://ftp.gnu.org/gnu/mpc/mpc-${MPC_VER}.tar.gz    | tar xz

# GCC source.
RUN mkdir -p /src && \
    curl -fsSL https://ftp.gnu.org/gnu/gcc/gcc-${GCC_VER}/gcc-${GCC_VER}.tar.xz \
      | tar xJ -C /src --strip-components=1

WORKDIR /src
COPY ./build.sh /build.sh
RUN chmod +x /build.sh && \
    GMP_VER=${GMP_VER} MPFR_VER=${MPFR_VER} MPC_VER=${MPC_VER} /build.sh /dist

FROM scratch AS export
COPY --from=builder /dist/ /
