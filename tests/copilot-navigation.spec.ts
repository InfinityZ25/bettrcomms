import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type HostState = { clears: number; syncs: number; uploads: number; marks: string[] };

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `API status ${response.status()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string) {
  const deadline = Date.now() + 65_000;
  let response: APIResponse;
  for (;;) {
    response = await context.request.post('/api/v1/auth/dev', {
      headers, data: { name, email: `copilot-navigation-${crypto.randomUUID()}@example.test` },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await response.dispose();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const result = await json<User | { user: User }>(response);
  return 'user' in result ? result.user : result;
}

async function mockNativeCopilot(page: Page) {
  // Only the overlay boundary is mocked. Real call state, peer permissions,
  // WebRTC, API and database run; this is not physical Windows acceptance.
  await page.route('**/src/desktop/capabilities.ts*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain('return browserCapabilities();');
    await route.fulfill({ response, body: body.replace('return browserCapabilities();',
      'const report = browserCapabilities(); report.nativeOverlays = {state:"experimental",detail:"Native overlay test fixture"}; return report;') });
  });
  await page.route('**/src/media/nativeCaptureRegistry.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const registerNativeScreenTrack = () => {};
export const nativeScreenSessionForTrack = track => track ? 'navigation-share' : undefined;`,
  }));
  await page.route('**/src/desktop/copilot.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `const cached = new Set();
function report() { window.__copilotHost.marks = [...cached]; }
export async function clearNativeCopilot() { window.__copilotHost.clears++; cached.clear(); report(); }
export async function uploadNativeCopilotFrame(frame) { window.__copilotHost.uploads++; cached.add(frame.markId); report(); }
export async function syncNativeCopilot(update) {
  window.__copilotHost.syncs++;
  const keep = new Set(update.marks.map(mark => mark.markId));
  for (const id of cached) if (!keep.has(id)) cached.delete(id);
  report();
  return {state:'visible',missing:update.marks.filter(mark => !cached.has(mark.markId)).map(mark => mark.markId)};
}`,
  }));
}

const counters = (page: Page) => page.evaluate(() =>
  (window as unknown as { __copilotHost: HostState }).__copilotHost);

test('native copilot belongs to the call while navigating Home and text, and releases on hangup', async ({ browser }) => {
  test.setTimeout(160_000);
  const ownerContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const viewerContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  for (const context of [ownerContext, viewerContext]) await context.addInitScript(() => {
    localStorage.setItem('bc-visual-copilot-v1', JSON.stringify({ enabled: true, showPings: true, showCards: true, cardSeconds: 0 }));
  });
  await ownerContext.addInitScript(() => {
    Object.assign(window, { __copilotHost: { clears: 0, syncs: 0, uploads: 0, marks: [] } });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const graphics = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        graphics.fillStyle = '#087e35'; graphics.fillRect(0, 0, 640, 360);
        graphics.fillStyle = '#fff'; graphics.fillRect(frame++ % 20, 10, 10, 10);
      };
      paint();
      const stream = canvas.captureStream(10);
      const track = stream.getVideoTracks()[0], timer = setInterval(paint, 100);
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); canvas.width = 0; canvas.height = 0; };
      Object.assign(window, { __copilotSharedTrack: track });
      return stream;
    } });
  });
  try {
    await login(ownerContext, 'Navigation Owner');
    const guest = await login(viewerContext, 'Navigation Viewer');
    const { request } = await json<{ request: { id: string } }>(await ownerContext.request.post('/api/v1/friends/requests', { headers, data: { user_id: guest.id } }));
    await json(await viewerContext.request.post(`/api/v1/friends/requests/${request.id}/accept`, { headers, data: {} }));
    const { room } = await json<{ room: { id: string; name: string } }>(await ownerContext.request.post('/api/v1/rooms', { headers, data: { name: 'Copilot navigation' } }));
    await json(await ownerContext.request.post(`/api/v1/rooms/${room.id}/members`, { headers, data: { user_id: guest.id } }));
    await json(await ownerContext.request.post('/api/v1/rooms/direct', { headers, data: { user_id: guest.id } }));
    const owner = await ownerContext.newPage(), viewer = await viewerContext.newPage();
    await mockNativeCopilot(owner);
    for (const page of [owner, viewer]) {
      await page.goto('/');
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Rooms', exact: true }).click();
      await page.getByRole('list', { name: `${room.name} channel list`, exact: true })
        .getByRole('button', { name: room.name, exact: true }).click();
      await page.getByRole('region', { name: `${room.name} · ${room.name}`, exact: true })
        .getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
    }
    await owner.getByRole('button', { name: 'Share screen', exact: true }).click();
    await viewer.getByRole('button', { name: 'Watch Navigation Owner' }).click();
    await expect.poll(() => viewer.locator('.stage-content-pane video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await owner.getByRole('checkbox', { name: 'Allow captures from Navigation Viewer' }).check();
    await viewer.getByRole('button', { name: 'Freeze & mark', exact: true }).click();
    await viewer.locator('.copilot-pointer-surface').press('Enter');
    await viewer.getByRole('button', { name: 'Send marked capture', exact: true }).click();
    await expect.poll(async () => (await counters(owner)).marks.length).toBe(1);
    await expect(viewer.locator('.copilot-presentation')).toHaveText('Over shared source · visible');
    const retained = await counters(owner);
    expect(retained.uploads).toBe(1);
    expect(retained.clears).toBeGreaterThan(0);

    const expectRetained = async () => {
      await expect(owner.locator('[data-app-shell]')).toHaveAttribute('data-in-call', 'true');
      const before = (await counters(owner)).syncs;
      await expect.poll(async () => (await counters(owner)).syncs).toBeGreaterThan(before);
      expect(await counters(owner)).toMatchObject({ clears: retained.clears, uploads: retained.uploads, marks: retained.marks });
      expect(await owner.evaluate(() => (window as unknown as { __copilotSharedTrack: MediaStreamTrack }).__copilotSharedTrack.readyState)).toBe('live');
      await expect(viewer.locator('.copilot-presentation')).toHaveText('Over shared source · visible');
    };

    await owner.getByRole('button', { name: 'Recordings', exact: true }).click();
    await expect(owner.getByRole('main', { name: 'Recordings' })).toBeVisible();
    await expectRetained();
    await owner.getByRole('button', { name: 'Bettercomms home', exact: true }).click();
    await expect(owner.locator('.call-workspace')).toBeVisible();
    await expectRetained();

    await owner.getByRole('button', { name: 'Messages', exact: true }).click();
    await owner.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Navigation Viewer', exact: true }).click();
    await expect(owner.getByRole('region', { name: 'Conversation with Navigation Viewer', exact: true })).toBeVisible();
    await expect(owner.locator('.call-workspace')).toHaveCount(0);
    await expectRetained();

    await owner.getByRole('button', { name: 'Back to the call in Copilot navigation', exact: true }).click();
    await expect(owner.getByRole('checkbox', { name: 'Allow captures from Navigation Viewer' })).toBeChecked();
    await expect(owner.getByRole('img', { name: 'Frame marked by Navigation Viewer' })).toBeVisible();
    await expectRetained();
    await owner.getByRole('button', { name: 'Messages', exact: true }).click();
    await owner.getByRole('region', { name: 'Direct messages' }).getByRole('button', { name: 'Navigation Viewer', exact: true }).click();
    await expect(owner.locator('.call-workspace')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(owner.locator('[data-app-shell]')).toHaveAttribute('data-in-call', 'false');
    await expect.poll(async () => (await counters(owner)).marks).toEqual([]);
    await expect.poll(async () => (await counters(owner)).clears).toBeGreaterThan(retained.clears);
    expect(await owner.evaluate(() => (window as unknown as { __copilotSharedTrack: MediaStreamTrack }).__copilotSharedTrack.readyState)).toBe('ended');
  } finally {
    await Promise.allSettled([ownerContext.close(), viewerContext.close()]);
  }
});
