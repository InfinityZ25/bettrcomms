# Bettercomms API

Requires Go 1.24 and PostgreSQL. The server applies `migrations/001_init.sql` at startup.

From `server/`, copy `.env.example` to `.env` or provide the variables through the process environment, then run:

```powershell
go run ./cmd/server
```

`DATABASE_URL` is required. WorkOS login also requires `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. `WORKOS_REDIRECT_URI` must exactly match the AuthKit redirect; local development defaults to `http://localhost:5173/api/v1/auth/callback`, which Vite proxies to the API. Sessions use opaque random cookies with only their hashes stored in PostgreSQL.

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
