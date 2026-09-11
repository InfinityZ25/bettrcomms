#!/usr/bin/env bash
# Renders turnserver.conf from its template (never edit turnserver.conf by
# hand — it's gitignored precisely because it ends up holding a real
# secret) and (re)starts the stack. Run this from the VPS, in this
# directory, after `git pull`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and fill in real values first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source .env

if [[ -z "${TURN_SECRET:-}" || "${TURN_SECRET}" == "replace-with-a-real-random-secret" ]]; then
  echo "error: set a real TURN_SECRET in .env before deploying." >&2
  exit 1
fi
if [[ -z "${SFU_JOIN_SECRET:-}" || "${SFU_JOIN_SECRET}" == "replace-with-a-real-random-secret-at-least-32-bytes-long" ]]; then
  echo "error: set a real SFU_JOIN_SECRET in .env before deploying." >&2
  exit 1
fi

sed "s|REPLACE_WITH_RAILWAY_TURN_SECRET|${TURN_SECRET}|" turnserver.conf.template > turnserver.conf
# 644, not 600: coturn's official image runs as uid 65534 (nobody), which
# can't read a root-owned 600 file — it silently falls back to defaults
# instead of erroring, which is what made this worth a comment. This box
# has no other local users, so world-readable is an acceptable tradeoff
# for a file only reachable by processes already running on it.
chmod 644 turnserver.conf

docker compose build sfu
docker compose up -d

echo
echo "deployed. checking health..."
sleep 3
curl -fsS http://127.0.0.1:8443/health 2>/dev/null \
  || docker compose exec -T sfu curl -fsS http://127.0.0.1:8443/health \
  || echo "warning: could not reach /health directly (this is expected if 8443 isn't published on the host — check 'docker compose ps' and 'curl https://sfu.bettrcomms.com/health' instead)."
