# Build the LLVM IR backend tools — llc, opt, lld, llvm-mc, llvm-objcopy — to
# WebAssembly, so a host can compile LLVM IR (.ll/.bc) to object code and link it
# to firmware entirely in a browser, WKWebView, or Node.js. Unlike the GCC tracks
# (one cc1plus.wasm per arch), LLVM is multi-target in a SINGLE binary: one
# llc.wasm covers ARM/AArch64/RISC-V/AVR + experimental Xtensa — the input IR (or
# `-mtriple`) selects the backend. Same export-from-scratch infra as src/arm-gcc.
#
# NOTE: cross-compiling LLVM with Emscripten is heavy (multi-hour, RAM-hungry) and
# may need tuning per LLVM release; the build runs in CI (release-llvm.yml), gated
# behind a gha cache like the gcc tracks. See src/llvm/build.sh.
FROM emscripten/emsdk:4.0.22 AS builder

ARG LLVM_VER=19.1.7
# Targets baked into the multi-target backend. Xtensa is upstream-experimental
# (ESP32 classic); kept here so the ESP32/C3 tracks can reuse this one backend.
ARG LLVM_TARGETS="ARM;AArch64;RISCV;AVR"
ARG LLVM_EXPERIMENTAL_TARGETS="Xtensa"

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl xz-utils build-essential cmake ninja-build python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# llvm-project source (the monorepo tarball; we only configure llvm + lld).
RUN mkdir -p /src && \
    curl -fsSL "https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VER}/llvm-project-${LLVM_VER}.src.tar.xz" \
      | tar xJ -C /src --strip-components=1

WORKDIR /src
COPY ./build.sh /build.sh
RUN chmod +x /build.sh && \
    LLVM_TARGETS="${LLVM_TARGETS}" LLVM_EXPERIMENTAL_TARGETS="${LLVM_EXPERIMENTAL_TARGETS}" /build.sh /dist

FROM scratch AS export
COPY --from=builder /dist/ /
