# Build the permissive ARM-target runtime libraries (compiler-rt builtins +
# picolibc, for RP2040 armv6-m and RP2350 armv8-m.main) that a clang toolchain
# needs to link Pico firmware. See src/pico-clang/build.sh for the rationale.
#
# These are TARGET (arm) static libs cross-compiled by a host LLVM — not a wasm
# build. The clang.wasm / lld.wasm that consume them come from the llvm track;
# this context only produces their missing permissive link inputs, replacing the
# GPL libgcc/newlib with compiler-rt (Apache-2.0) + picolibc (BSD).
FROM debian:bookworm-slim AS builder

ARG LLVM_VER=19.1.7
ARG PICOLIBC_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
        clang lld llvm cmake ninja-build meson python3 git curl ca-certificates xz-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# compiler-rt source + the LLVM cmake modules the standalone builtins build mocks.
RUN mkdir -p /src && cd /src && \
    base="https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VER}" && \
    curl -fsSL "$base/compiler-rt-${LLVM_VER}.src.tar.xz" | tar xJ && \
    git clone --depth 1 --branch "${PICOLIBC_REF}" https://github.com/picolibc/picolibc.git

COPY ./build.sh /build.sh
RUN chmod +x /build.sh && \
    LLVM_BIN=$(dirname $(command -v clang)) \
    COMPILER_RT_SRC=$(ls -d /src/compiler-rt-*.src) \
    LLVM_CMAKE_DIR=$(dirname $(find /usr/lib/llvm-* -name AddLLVM.cmake | head -1)) \
    PICOLIBC_SRC=/src/picolibc \
    OUT=/dist \
    /build.sh

FROM scratch AS export
COPY --from=builder /dist/ /
