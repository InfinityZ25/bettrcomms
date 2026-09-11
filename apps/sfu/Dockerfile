# syntax=docker/dockerfile:1

# --- builder -----------------------------------------------------------
FROM rust:1.98-slim-trixie AS builder
WORKDIR /build

# Cache dependency compilation separately from source changes.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs \
    && cargo build --release || true

COPY src ./src
# Touch main.rs so the placeholder build above doesn't shadow the real one
# via cargo's mtime-based fingerprinting.
RUN touch src/main.rs && cargo build --release

# --- runtime -------------------------------------------------------------
# debian-slim, not distroless: we need a shell-less but glibc-compatible
# base with CA certs for nothing else outbound; kept minimal on purpose.
FROM debian:trixie-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 sfu

COPY --from=builder /build/target/release/bettrcomms-sfu /usr/local/bin/bettrcomms-sfu

USER sfu
# HTTP/WS signaling port; UDP media port is separate (see .env.example) and
# not exposed here since EXPOSE is documentation only — the compose file /
# `docker run` -p flags are what actually publish it.
EXPOSE 8443/tcp
EXPOSE 3478/udp

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${HTTP_ADDR##*:}/liveness || exit 1

ENTRYPOINT ["/usr/local/bin/bettrcomms-sfu"]
