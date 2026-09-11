import { getDesktopApiTransport } from './runtime';

/**
 * Must stay identical to TokenQueryParam in
 * apps/desktop-wails/internal/desktop/apiproxy.go. A WebSocket handshake cannot
 * carry a header from page script, so the launch secret travels in the URL for
 * those and in the Authorization header for everything else.
 */
const TOKEN_QUERY_PARAM = '__bc_token';

/**
 * Where API traffic goes, for every host.
 *
 * A browser tab and a development desktop build both reach the API same-origin
 * and these helpers change nothing. A packaged desktop host cannot: its page
 * origin serves no API, and the upstream session cookie is SameSite=Lax, so the
 * host proxies both HTTP and WebSocket traffic through loopback. These helpers
 * are the single place that knows which situation applies.
 */

/** Absolute URL for an app-relative API path. */
export function apiHttpUrl(path: string): string {
  const transport = getDesktopApiTransport();
  return transport ? new URL(path, transport.base).href : path;
}

/**
 * Whether a request built by apiHttpUrl may carry cookies.
 *
 * Same-origin, they are the whole point: the session cookie is what
 * authenticates a browser tab and a development desktop build.
 *
 * Through the host's loopback proxy they must not be sent at all. The page has
 * no cookies for that origin — the session lives in the host process, which is
 * the entire reason the proxy exists — and asking for credentials on a
 * cross-origin request obliges the server to answer
 * `Access-Control-Allow-Credentials: true`. The proxy deliberately does not,
 * because it accepts none, so a credentialed request is refused by the browser
 * before it is ever sent. Authorisation here is the bearer token below.
 */
export function apiCredentials(): RequestCredentials {
  return getDesktopApiTransport() ? 'omit' : 'include';
}

/** The header authorising a request built by apiHttpUrl. Empty off-desktop. */
export function apiAuthHeaders(): Record<string, string> {
  const transport = getDesktopApiTransport();
  return transport ? { Authorization: 'Bearer ' + transport.token } : {};
}

/**
 * ws(s) URL for an app-relative API path.
 *
 * The token is appended only when the result actually points at this host's own
 * loopback proxy, so an absolute URL for somewhere else can never be handed the
 * launch secret.
 */
export function apiSocketUrl(path: string): string {
  const transport = getDesktopApiTransport();
  const base = transport?.base ?? globalThis.location?.href ?? 'https://localhost';
  const url = new URL(path, base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new TypeError('API socket URL must use http(s) or ws(s)');
  if (transport && url.host === new URL(transport.base).host)
    url.searchParams.set(TOKEN_QUERY_PARAM, transport.token);
  return url.href;
}
