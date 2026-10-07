# Bettercomms API

Requires Go 1.24 and PostgreSQL. The server applies `migrations/001_init.sql` at startup.

From `server/`, copy `.env.example` to `.env` or provide the variables through the process environment, then run:

```powershell
go run ./cmd/server
```

`DATABASE_URL` is required. WorkOS login also requires `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. `WORKOS_REDIRECT_URI` must exactly match the AuthKit redirect; local development defaults to `http://localhost:5173/api/v1/auth/callback`, which Vite proxies to the API. Sessions use opaque random cookies with only their hashes stored in PostgreSQL.

Message attachments require an existing **private** S3 bucket. Set `AWS_S3_BUCKET` and `AWS_REGION` in the server's private `.env`. For local development, also set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; an IAM role or `AWS_PROFILE` may supply credentials instead. Grant `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on the bucket's `messages/*` objects. The API uploads files and issues five-minute signed download URLs, so the browser does not need S3 credentials or bucket CORS rules. Restart the API after setting these values. Without a bucket, attachment controls report that storage is unavailable; text messages still work. Do not put credentials in `VITE_` variables or commit `.env`.

Ordinary files default to **500 MiB each**, with up to four attachments per message. Set `ATTACHMENT_MAX_BYTES` to a byte count between 1048576 and 2147483648 to change the ordinary-file limit. Voice notes remain capped at 10 MiB and two minutes independently. Uploads spool to private temporary files and stream from disk to S3; reserve sufficient temporary disk space and configure any reverse proxy's request limit/timeouts for the chosen size. Signature detection accepts common MP4 brands, media, plain text, PDF, ZIP/Office/OpenDocument/EPUB and common compressed archives; executable and active web formats remain rejected. Cancelling a completed pending upload revokes it immediately and deletes its S3 object, with periodic cleanup retrying storage failures. Migration `015_attachment_limits.sql` raises the database constraint. See the [test plan](../docs/TEST_PLAN.md) for completed build, database and browser checks and remaining production size/network acceptance. Type detection does not provide malware scanning.

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
