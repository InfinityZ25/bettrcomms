# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS web-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
RUN npm run build

FROM golang:1.26-alpine AS server-build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bettercomms ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S bettercomms \
    && adduser -S -G bettercomms bettercomms
WORKDIR /app
COPY --from=server-build /out/bettercomms ./bettercomms
COPY server/migrations ./migrations
COPY --from=web-build /src/apps/web/dist ./web
ENV WEB_DIST=/app/web \
    MIGRATIONS_DIR=/app/migrations
USER bettercomms
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1
CMD ["sh", "-c", "case ${PORT:-8080} in *[!0-9]*|'') echo 'PORT must be numeric' >&2; exit 2;; esac; export HTTP_ADDR=\":${PORT:-8080}\"; exec ./bettercomms"]
