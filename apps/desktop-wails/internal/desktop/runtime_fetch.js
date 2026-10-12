// Installed by the host before any application or Wails runtime module runs.
// A child frame never gets a fetch function that signs native requests.
(() => {
  const report = window.__BETTERCOMMS_DESKTOP__;
  if (window !== window.top || report?.runtime !== 'wails' ||
      typeof report.pageToken !== 'string' || !report.pageToken ||
      typeof window.fetch !== 'function') return;

  const pageURL = new URL(window.location.href);
  const token = report.pageToken;
  const fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let target;
    try {
      target = new URL(input instanceof Request ? input.url : input, pageURL);
    } catch {
      return fetch(input, init);
    }
    // Comparing protocol/host as well as origin distinguishes opaque wails:
    // origins from unrelated URLs whose origin is also serialized as "null".
    if (target.origin !== pageURL.origin || target.protocol !== pageURL.protocol ||
        target.host !== pageURL.host || target.username || target.password ||
        target.pathname !== '/wails/runtime') return fetch(input, init);

    const headers = new Headers(init?.headers ??
      (input instanceof Request ? input.headers : undefined));
    headers.set('X-BetterComms-Page-Proof', token);
    // This private header must never follow a redirect to another origin.
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
})();
