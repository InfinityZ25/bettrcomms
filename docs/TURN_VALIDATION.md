# TURN validation

The opt-in Playwright test proves that the credentials returned by the authenticated
`GET /api/v1/ice` endpoint can establish a real relay-only WebRTC data channel.
It sets `iceTransportPolicy: "relay"`, exchanges complete SDP descriptions, sends
a message, and confirms that the selected local candidate on both peers is `relay`.

Run the web app, API, and local coturn service, then use:

```powershell
$env:E2E_TURN = "true"
npx playwright test tests/turn.spec.ts
```

The test is skipped during the normal suite because coturn is an optional external
service. A passing result establishes only that two browser peers on this development
machine can use the configured relay. It does not establish that the relay is reachable
from another network or correctly advertised for production.

If relay ICE gathering or the data channel times out on Windows with coturn in Docker,
inspect the candidates and container logs. An advertised Docker bridge address such as
`172.x.x.x` is usually unreachable from browser peers outside that bridge. For a local-only
test, coturn may need a loopback-reachable advertised address, loopback peers explicitly
allowed, and ports bound only to loopback. Those settings are unsuitable evidence for a
public deployment. Production needs a routable public address (or valid NAT mapping),
reachable UDP/TCP relay port ranges, TLS where required, and validation from a genuinely
external network.
