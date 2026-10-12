import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const proofHeader = 'X-BetterComms-Page-Proof';
const networkFetch = globalThis.fetch;
let sdkRequests = 0;
globalThis.window = globalThis;
window.top = window;
window.location = { href: fixture.pageOrigin + '/', origin: fixture.pageOrigin };
const pageURL = new URL(window.location.href);
globalThis.document = {};
window.fetch = async (url, init) => {
  const target = new URL(url, window.location.href);
  const headers = new Headers(init?.headers);
  if (target.protocol !== pageURL.protocol || target.host !== pageURL.host || target.pathname !== '/wails/runtime') {
    assert(!headers.has(proofHeader), 'Proof was sent outside the native RPC route');
    return new Response(null, { status: 204 });
  }
  sdkRequests++;
  assert(headers.has(proofHeader), 'SDK request did not carry its document proof');
  assert.equal(init.redirect, 'error', 'Proof may follow redirects');
  // Replace only the native asset transport. The installed SDK still builds
  // the actual POST/GET/chunk requests; Go receives the platform's asset Host
  // and the selected serialized request Origin, including opaque/absent forms.
  if (fixture.requestOrigin) headers.set('Origin', fixture.requestOrigin);
  headers.set('Sec-Fetch-Site', 'same-origin');
  return networkFetch(fixture.server + target.pathname + target.search, { ...init, headers });
};
vm.runInThisContext(fixture.source);

const runtime = await import(pathToFileURL(join(fixture.sdk, 'runtime.js')).href);
const calls = await import(pathToFileURL(join(fixture.sdk, 'calls.js')).href);
assert((await runtime.newRuntimeCaller(runtime.objectNames.Window, 'main')(2)).accepted);
assert((await calls.ByName('main.AuthService.BrowserSignInStatus')).accepted);
assert((await calls.ByName('main.NativeMediaService.CameraOverlayFrame', 'a'.repeat(600000))).accepted);
assert((await fetch('/wails/runtime?object=6&method=2')).ok);
assert.equal(sdkRequests, 5, 'Chunked and ordinary SDK calls changed');
await fetch('https://player.bettrcomms.com/wails/runtime');
await fetch('https://app.bettrcomms.com/api/v1/me');
await fetch('/wails/runtime.js');
await fetch('/wails/runtime/');

// Exercise the injected production script independently in a child frame and
// in an opaque native origin. Do not duplicate its signing implementation.
function context(href, mainFrame = true) {
  const requests = [];
  const scope = { URL, Request, Headers, location: { href }, fetch: async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  } };
  scope.window = scope;
  scope.top = mainFrame ? scope : {};
  vm.runInNewContext(fixture.source, scope);
  return { scope, requests };
}

const child = context('https://player.bettrcomms.com/player', false);
await child.scope.fetch('http://wails.localhost/wails/runtime', { method: 'POST', body: '{"object":6,"method":2}' });
assert(!new Headers(child.requests[0].init?.headers).has(proofHeader), 'Child frame received a signer');

for (const host of ['localhost', 'wails']) {
  const opaque = context(`wails://${host}/index.html`);
  await opaque.scope.fetch('/wails/runtime?object=6&method=2');
  assert(new Headers(opaque.requests[0].init.headers).has(proofHeader), 'Opaque native same-origin RPC lost proof');
  await opaque.scope.fetch('wails://foreign/wails/runtime');
  assert(!new Headers(opaque.requests[1].init?.headers).has(proofHeader), 'Opaque-origin equality leaked proof');
  await opaque.scope.fetch(`wails://${host}:80/wails/runtime`);
  assert(!new Headers(opaque.requests[2].init?.headers).has(proofHeader), 'Native same-host port variant received proof');
  await opaque.scope.fetch(`wails://user@${host}/wails/runtime`);
  assert(!new Headers(opaque.requests[3].init?.headers).has(proofHeader), 'Native URL with credentials received proof');
}

const main = context('http://wails.localhost/');
const abort = new AbortController();
const request = new Request('http://wails.localhost/wails/runtime', {
  method: 'POST', body: 'original-body', headers: { 'x-wails-client-id': 'original-client' }, signal: abort.signal,
});
await main.scope.fetch(request);
const signed = main.requests[0];
assert.equal(signed.url, request, 'Request body/signal object was replaced');
assert.equal(signed.init.headers.get('x-wails-client-id'), 'original-client');
assert(new Headers(signed.init.headers).has(proofHeader));
assert.equal(signed.init.redirect, 'error');
assert.equal(await request.text(), 'original-body', 'Signing consumed the Request body');
await main.scope.fetch(request, { headers: { 'x-wails-client-id': 'init-client' } });
assert.equal(main.requests[1].init.headers.get('x-wails-client-id'), 'init-client');
