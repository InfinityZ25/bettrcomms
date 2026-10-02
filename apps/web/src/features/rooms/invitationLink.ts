const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const storageKey = 'bettercomms:pending-invitation';
const pendingLifetime = 2 * 60 * 60 * 1000;

export function invitationToken(value: string): string | null {
  const text = value.trim();
  if (tokenPattern.test(text)) return text;
  if (text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const query = url.hash.indexOf('?');
    if (query < 0) return null;
    const token = new URLSearchParams(url.hash.slice(query + 1)).get('invite');
    return token && tokenPattern.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function pendingInvitation(): string | null {
  const fromUrl = invitationToken(window.location.href);
  if (fromUrl) return fromUrl;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { token?: unknown; expires?: unknown } | null;
    return saved && typeof saved.token === 'string' && tokenPattern.test(saved.token)
      && typeof saved.expires === 'number' && saved.expires > Date.now()
      && saved.expires <= Date.now() + pendingLifetime ? saved.token : null;
  } catch {
    return null;
  }
}

export function rememberInvitation(token: string | null) {
  try {
    if (token && tokenPattern.test(token)) sessionStorage.setItem(storageKey, JSON.stringify({ token, expires: Date.now() + pendingLifetime }));
    else sessionStorage.removeItem(storageKey);
  } catch { /* The invitation still works for this open page without storage. */ }
  const url = new URL(window.location.href);
  const query = url.hash.indexOf('?');
  if (query < 0) return;
  const params = new URLSearchParams(url.hash.slice(query + 1));
  if (!params.has('invite')) return;
  params.delete('invite');
  url.hash = url.hash.slice(0, query) + (params.size ? '?' + params.toString() : '');
  window.history.replaceState(window.history.state, '', url);
}
