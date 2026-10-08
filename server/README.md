# Bettercomms API

Requires Go 1.24 and PostgreSQL. The server applies `migrations/001_init.sql` at startup.

From `server/`, copy `.env.example` to `.env` or provide the variables through the process environment, then run:

```powershell
go run ./cmd/server
```

`DATABASE_URL` is required. WorkOS login also requires `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. `WORKOS_REDIRECT_URI` must exactly match the AuthKit redirect; local development defaults to `http://localhost:5173/api/v1/auth/callback`, which Vite proxies to the API. Sessions use opaque random cookies with only their hashes stored in PostgreSQL.

Message attachments require an existing **private** S3 bucket. Set `AWS_S3_BUCKET` and `AWS_REGION` in the server's private `.env`. For local development, also set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; an IAM role or `AWS_PROFILE` may supply credentials instead. Grant `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, and `s3:AbortMultipartUpload` on the bucket's `messages/*` objects. Add an S3 lifecycle rule to abort incomplete multipart uploads after seven days as a fallback for a process failure between creating a multipart upload and persisting its identifier. The API uploads files and issues five-minute signed download URLs, so the browser does not need S3 credentials or bucket CORS rules. Restart the API after setting these values. Without a bucket, attachment controls report that storage is unavailable; text messages still work. Do not put credentials in `VITE_` variables or commit `.env`.

Ordinary files default to **500 MiB each**, with up to four attachments per message. Set `ATTACHMENT_MAX_BYTES` to a byte count between 1048576 and 2147483648 to change the ordinary-file limit. Voice notes remain capped at 10 MiB and two minutes independently. Ordinary browser uploads use 8 MiB S3 multipart chunks, verify SHA-256 per chunk, and store offset/part identifiers in PostgreSQL so an API restart or client retry preserves completed parts. Upload sessions are bound to the initiating login session and expire after 24 hours; pending files and text drafts are retained in the browser's IndexedDB/localStorage when storage permits. Pausing keeps progress; removing the file cancels it. Legacy uploads spool to private temporary files and stream from disk to S3; reserve temporary disk space and configure reverse-proxy limits/timeouts for the chosen route. Signature detection accepts common MP4 brands, media, plain text, PDF, ZIP/Office/OpenDocument/EPUB and common compressed archives; executable and active web formats remain rejected. The channel file library filters author/date/type and renders PDFs up to 20 MiB as canvas pages without scripting, links or forms. Owners/admins can set a community quota and attachment retention; in-progress uploads reserve their full size atomically. Active stickers/soundboard assets are excluded from retention and pending cleanup. Deletion revokes use immediately; periodic cleanup retries failed physical deletion. Migrations `015` and `017` add size/storage state. Production maximum-size/network acceptance remains a separate deployment check.

Malware scanning is optional and **disabled by default**, accurately reported by `/api/v1/config` and the storage panel. Set `ATTACHMENT_SCAN_MODE=clamav`, `CLAMAV_ADDRESS=127.0.0.1:13310`, `CLAMAV_SCAN_TIMEOUT_SECONDS=120`, and `CLAMAV_MAX_SCAN_BYTES=524288000` to use a real ClamAV daemon. `docker compose --profile scanning up -d attachment-scanner` starts the optional local service. `server/clamd.conf` explicitly sets `StreamMaxLength 500M` and `MaxFileSize 500M`; update both when changing the API scan limit. Archive size/recursion limits and encryption alerts reject incomplete scans. Enabled scanning fails closed on timeout, connection failure, unknown results or scan limits: new objects stay private and cannot be attached or downloaded until clean. Positive results are rejected and deleted with retryable cleanup. Existing files are not retrospectively scanned. Keep the daemon's signature updates healthy and add any required corporate CA trust to its container without disabling TLS verification.

For local coturn REST authentication, configure the same secret in coturn's `static-auth-secret` and `TURN_SECRET`, and set comma-separated `TURN_URLS`. Authenticated clients fetch ten-minute credentials from `GET /api/v1/ice`. The public config endpoint exposes STUN URLs only.

Set `WEB_DIST` to a built web directory to serve its static assets and `index.html` SPA fallback from the Go process. Leave it empty when Vite or another web server owns the UI.

Migrations run in filename order from `MIGRATIONS_DIR`. When unset, the server locates either `migrations/` or `server/migrations/`, allowing launch from the server or repository root. `SIGINT` and `SIGTERM` trigger a bounded ten-second graceful HTTP shutdown.

Build the production API image from this directory with `docker build -t bettercomms-server .`.

`DEV_AUTH=true` enables local test sign-in only when both the request host and remote address are loopback. Never enable it on a shared environment. Browser mutations reject cross-site origins. Room invitations require the caller to own the room and the invited user to be an accepted friend.

Validation:

```powershell
go test ./...
go vet ./...
$env:TEST_DATABASE_URL='postgres://bettercomms:local-development-only@localhost:54329/bettercomms?sslmode=disable'
go test ./internal/api -run TestWebSocketSignalIntegration -v
```

See `PROTOCOL.md` for routes and signaling frames.
