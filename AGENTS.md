# Bettercomms development

This repository is a browser and native communication application. Preserve the agreed React/Vite/TypeScript frontend, Go server, PostgreSQL persistence, WorkOS authentication, and Tauri boundary. Local Docker is the default development infrastructure; do not replace this with a hosted-site scaffold.

## Scope and ownership

- Read `docs/PRODUCT_SPEC.md` and `docs/RELEASE_NOTES.md` for product requirements and current limitations.
- Do not claim native process capture, GPU encoding, NVIDIA/Krisp integration, packaged auth, or continuous rewind works until its actual acceptance tests pass.
- Keep media sources independent: microphone, camera, screen, and system audio per participant. Playback volume must not alter recorded source tracks.
- End screen and system audio together. Release device tracks, AudioContexts, worklets, recorders, socket writers, and listeners on every stop/error/disconnect path.
- Never expose WorkOS API keys, session tokens, or TURN secrets in `VITE_` variables, logs, tests, screenshots, or Git. Root `.env` and `.local/` are private.
- Keep development authentication opt-in and loopback-only. Do not weaken origin or membership checks to make tests pass.

## Validation

Run `npm run build`, `npm test`, and appropriate Playwright tests. Backend changes require `go test ./...` and `go vet ./...` inside `server/`. Set `TEST_DATABASE_URL` to the local Docker database to include integration tests. Browser tests use the real API and database with synthetic media; they do not prove native capture or cross-network connectivity.

Prefer targeted tests while iterating and one full pass after the final changes. Do not run multiple Playwright suites concurrently against the same local auth rate limiter or overwrite screenshots from another test run.

Use npm workspaces and preserve the lockfile. Do not switch to pnpm. The desktop package is separately installable until its compiler/auth gates are cleared.
