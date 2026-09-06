# Backend security notes

Authentication cookies contain 256-bit random opaque tokens, are unreadable to scripts (`HttpOnly`), scoped to the application, `SameSite=Lax`, and expire after 14 days. Only SHA-256 token hashes are stored in PostgreSQL. Set `COOKIE_SECURE=true` whenever HTTPS is used.

Logout deletes the current server-side session and expires the browser cookie. Expiration is checked by PostgreSQL and expired rows are opportunistically removed whenever a new session is created.

OAuth authorization state is random, single-use, expires after ten minutes, and must match an `HttpOnly` state cookie. Browser mutations require the configured `APP_URL` origin and JSON bodies. WebSocket identity always comes from the session cookie; client-provided sender IDs are overwritten. Room membership is checked before upgrading or exposing participant identities.

`DEV_AUTH` checks both the request host and TCP peer for loopback. Reverse-proxy deployments must keep it disabled because the API deliberately does not trust forwarded-address headers.
