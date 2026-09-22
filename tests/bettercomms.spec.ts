import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

type User = { id: string; name: string; email: string };
type Room = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

const syntheticDisplayCapture = () => {
  const original = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const graphics = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        graphics.fillStyle = frame++ % 2 ? '#6146e5' : '#19a974';
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        graphics.fillStyle = '#fff';
        graphics.font = '48px sans-serif';
        graphics.fillText('Synthetic screen', 90, 190);
      };
      paint();
      const timer = window.setInterval(paint, 100);
      const stream = canvas.captureStream(10);
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]!);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        clearInterval(timer);
        oscillator.stop();
        void context.close();
      }, { once: true });
      return stream;
    },
  });
  (window as unknown as { __originalDisplayCapture?: unknown }).__originalDisplayCapture = original;
};

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`API ${response.status()} ${response.url()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function devLogin(context: BrowserContext, name: string, email: string): Promise<User> {
  let response: APIResponse;
  const deadline = Date.now() + 65_000;
  for (;;) {
    response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin }, data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) break;
    await response.dispose();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const body = await json<User | { user: User }>(response);
  return 'user' in body ? body.user : body;
}

async function prepareRoom(ownerContext: BrowserContext, guestContext: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = await devLogin(ownerContext, 'Ada E2E', `ada-${suffix}@example.test`);
  const guest = await devLogin(guestContext, 'Grace E2E', `grace-${suffix}@example.test`);
  const requestResponse = await ownerContext.request.post('/api/v1/friends/requests', {
    headers: { Origin: origin }, data: { user_id: guest.id },
  });
  const friendRequest = await json<{ request: { id: string } }>(requestResponse);
  await json(await guestContext.request.post(`/api/v1/friends/requests/${friendRequest.request.id}/accept`, {
    headers: { Origin: origin }, data: {},
  }));
  const roomResponse = await ownerContext.request.post('/api/v1/rooms', {
    headers: { Origin: origin }, data: { name: `Media room ${suffix}` },
  });
  const { room } = await json<{ room: Room }>(roomResponse);
  await json(await ownerContext.request.post(`/api/v1/rooms/${room.id}/members`, {
    headers: { Origin: origin }, data: { user_id: guest.id },
  }));
  return { owner, guest, room };
}

async function expectDecodedVideo(page: Page, selector: string): Promise<void> {
  await expect.poll(async () => page.locator(selector).evaluateAll((videos: HTMLVideoElement[]) =>
    videos.some((video) => video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
  )).toBe(true);
}

async function callControl(page: Page, name: string) {
  // A second device can leave this pointer parked at the previous wake point.
  // Move between two distinct positions: same-coordinate hover is deliberately
  // ignored by the immersive controls, and force-click would hide that contract.
  const workspace = page.locator('.call-workspace');
  await workspace.hover({ position: { x: 20, y: 20 } });
  await workspace.hover({ position: { x: 10, y: 10 } });
  await expect(workspace).toHaveAttribute('data-controls-visible', 'true');
  await page.getByRole('button', { name, exact: true }).click();
}

test('two members chat, call, record separate tracks, and transport a screen share', async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext({ acceptDownloads: true, baseURL });
  const guestContext = await browser.newContext({ acceptDownloads: true, baseURL });

  try {
    const publicPage = await ownerContext.newPage();
    await publicPage.goto('/');
    await expect(publicPage.getByRole('button', { name: /workos/i })).toBeVisible();
    await publicPage.screenshot({ path: 'tests/screenshots/public-login.png', fullPage: true });

    const { room, guest } = await prepareRoom(ownerContext, guestContext);
    await json(await ownerContext.request.post('/api/v1/rooms/direct', {
      headers: { Origin: origin }, data: { user_id: guest.id },
    }));
    const ownerPage = publicPage;
    const guestPage = await guestContext.newPage();
    await Promise.all([ownerPage.reload(), guestPage.goto('/')]);
    ownerPage.setDefaultTimeout(15_000); guestPage.setDefaultTimeout(15_000);
    await ownerPage.getByRole('button', { name: 'Messages', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Grace E2E', exact: true }).click();
    await guestPage.getByRole('button', { name: 'Messages', exact: true }).click();
    await guestPage.getByRole('button', { name: 'Ada E2E', exact: true }).click();
    await ownerPage.screenshot({ path: 'tests/screenshots/signed-room.png', fullPage: true });

    const message = `persistent message ${Date.now()}`;
    await ownerPage.getByRole('textbox', { name: 'Message Grace E2E', exact: true }).fill(message);
    await ownerPage.getByRole('button', { name: /send message/i }).click();
    await expect(guestPage.getByText(message)).toBeVisible({ timeout: 3_000 });
    await guestPage.reload();
    await expect(guestPage.getByText(message)).toBeVisible();

    for (const page of [ownerPage, guestPage]) {
      await page.getByRole('button', { name: 'Calls', exact: true }).click();
      await page.getByRole('button', { name: room.name, exact: true }).click();
    }
    await Promise.all([
      ownerPage.getByRole('button', { name: /join call/i }).click(),
      guestPage.getByRole('button', { name: /join call/i }).click(),
    ]);
    await Promise.all([
      expect(ownerPage.locator('.camera-tile:not(.self)')).toHaveCount(1),
      expect(guestPage.locator('.camera-tile:not(.self)')).toHaveCount(1),
    ]);
    const network = ownerPage.getByRole('button', { name: 'Connection diagnostics' });
    await expect(network).toHaveAttribute('title', /Call ping: \d+ ms/);
    await network.click();
    const connection = ownerPage.getByRole('region', { name: 'Connection details' });
    await expect(connection.locator('dl > div').filter({ hasText: 'Server' })).toContainText(/\d+ ms/);
    await expect(connection).toContainText('Grace E2E');
    await connection.getByRole('button', { name: 'Everything else' }).click();
    const advanced = ownerPage.locator('.stats-panel');
    await expect(advanced).toBeVisible();
    await ownerPage.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        if (object instanceof Blob && object.type === 'application/json')
          void object.text().then(text => { (window as unknown as { __diagnosticText?: string }).__diagnosticText = text; });
        return original(object);
      };
    });
    const diagnosticDownload = ownerPage.waitForEvent('download');
    await advanced.getByRole('button', { name: 'Download diagnostic report' }).click();
    const diagnostic = await diagnosticDownload;
    expect(diagnostic.suggestedFilename()).toMatch(/^bettercomms-diagnostics-\d+\.json$/);
    await expect.poll(() => ownerPage.evaluate(() => (window as unknown as { __diagnosticText?: string }).__diagnosticText)).toBeTruthy();
    const diagnosticText = (await ownerPage.evaluate(() => (window as unknown as { __diagnosticText: string }).__diagnosticText));
    const diagnosticJson = JSON.parse(diagnosticText) as Record<string, unknown>;
    expect(diagnosticJson.version).toBe(2);
    expect(diagnosticJson.client).toMatchObject({ native: false });
    expect(diagnosticJson.screen).toBeTruthy();
    const diagnosticKeys = [...diagnosticText.matchAll(/"([^"\\]+)"\s*:/g)].map(match => match[1].toLowerCase());
    for (const forbidden of ['sdp', 'candidate', 'address', 'ip', 'token', 'credential', 'usernamefragment', 'deviceid'])
      expect(diagnosticKeys).not.toContain(forbidden);
    expect(diagnosticText).not.toContain('127.0.0.1');
    expect(diagnosticText).not.toContain('ice-pwd');
    await ownerPage.screenshot({ path: 'tests/screenshots/call-connection.png', fullPage: true });

    await openSettingsCategory(ownerPage);
    await ownerPage.keyboard.press('Escape');
    await expect(ownerPage.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
    await expect(ownerPage.locator('.camera-tile:not(.self)')).toHaveCount(1);
    await ownerPage.getByRole('button', { name: 'Recordings' }).click();
    await expect(ownerPage.getByRole('main', { name: 'Recordings' })).toBeVisible();
    await ownerPage.getByRole('button', { name: `Back to the call in ${room.name}`, exact: true }).click();
    await expect(ownerPage.getByRole('main', { name: 'Recordings' })).toBeHidden();
    await expect(ownerPage.locator('.camera-tile:not(.self)')).toHaveCount(1);

    // Start with audio only, then require tracks added later to join the same session.
    await callControl(ownerPage, 'Record separate tracks');
    await expect(ownerPage.getByText(/recording/i).first()).toBeVisible();
    await Promise.all([
      callControl(ownerPage, 'Turn on camera'),
      callControl(guestPage, 'Turn on camera'),
    ]);
    await Promise.all([
      expectDecodedVideo(ownerPage, '.camera-tile.self video'),
      expectDecodedVideo(ownerPage, '.camera-tile:not(.self) video'),
      expectDecodedVideo(guestPage, '.camera-tile:not(.self) video'),
    ]);

    await callControl(ownerPage, 'Fullscreen call');
    const fullscreenWorkspace = ownerPage.locator('.call-workspace');
    const fullscreenStage = fullscreenWorkspace.locator('.stage');
    await expect.poll(() => ownerPage.evaluate(() => document.fullscreenElement?.classList.contains('call-workspace'))).toBe(true);
    await expect(fullscreenStage).toHaveAttribute('data-has-share', 'false');
    await expect(fullscreenStage).toHaveAttribute('data-gallery', 'adaptive');
    await expect(fullscreenStage).toHaveAttribute('data-camera-count', '2');
    const fullscreenGeometry = await fullscreenWorkspace.evaluate((workspace) => {
      const tiles = [...workspace.querySelectorAll<HTMLElement>('.camera-tile:not(.invite)')].map((tile) => tile.getBoundingClientRect());
      const controls = workspace.querySelector<HTMLElement>('.call-controls')?.getBoundingClientRect();
      const stage = workspace.querySelector<HTMLElement>('.stage')!;
      const stageBox = stage.getBoundingClientRect();
      const style = getComputedStyle(stage);
      const top = parseFloat(style.paddingTop), bottom = parseFloat(style.paddingBottom);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        // The recording indicator reserves a top inset; centre within usable media space.
        mediaCenterY: stageBox.y + top + (stageBox.height - top - bottom) / 2,
        tiles: tiles.map(({ x, y, width, height }) => ({ x, y, width, height })),
        controls: controls && { x: controls.x, width: controls.width },
      };
    });
    expect(fullscreenGeometry.tiles).toHaveLength(2);
    const [leftCamera, rightCamera] = fullscreenGeometry.tiles;
    expect(leftCamera.width).toBeGreaterThan(fullscreenGeometry.viewport.width * .43);
    expect(rightCamera.width).toBeGreaterThan(fullscreenGeometry.viewport.width * .43);
    expect(Math.abs(leftCamera.width - rightCamera.width)).toBeLessThan(3);
    expect(Math.abs(leftCamera.height - rightCamera.height)).toBeLessThan(3);
    expect(rightCamera.x).toBeGreaterThan(leftCamera.x + leftCamera.width);
    expect(Math.abs((leftCamera.y + leftCamera.height / 2) - fullscreenGeometry.mediaCenterY)).toBeLessThan(4);
    expect(fullscreenGeometry.controls).toBeTruthy();
    expect(Math.abs((fullscreenGeometry.controls!.x + fullscreenGeometry.controls!.width / 2) - fullscreenGeometry.viewport.width / 2)).toBeLessThan(4);
    await ownerPage.screenshot({ path: '.local/two-camera-fullscreen.png', fullPage: true });
    await ownerPage.mouse.move(20, 450);
    await callControl(ownerPage, 'Exit fullscreen call');

    await ownerPage.evaluate(syntheticDisplayCapture);
    await callControl(ownerPage, 'Share screen');
    const ownerShareName = 'Ada E2E';
    await expect(guestPage.getByRole('button', { name: `Watch ${ownerShareName}` })).toBeVisible();
    await expect(guestPage.locator('.video-viewport video')).toHaveCount(0);
    await guestPage.getByRole('button', { name: `Watch ${ownerShareName}` }).click();
    await expectDecodedVideo(guestPage, '.video-viewport video');
    await expect(guestPage.locator('.stage-badge')).toHaveText('Live');
    await expect(guestPage.getByText('Waiting for video frames…')).toHaveCount(0);

    await guestPage.evaluate(syntheticDisplayCapture);
    await callControl(guestPage, 'Share screen');
    const guestShareName = 'Grace E2E';
    await expect(ownerPage.getByRole('button', { name: `Watch ${guestShareName}` })).toBeVisible();
    await ownerPage.getByRole('button', { name: `Watch ${guestShareName}` }).click();
    await expect(ownerPage.locator('.stage-content-pane')).toHaveCount(2);
    await Promise.all([
      expectDecodedVideo(ownerPage, '.stage-content-pane video'),
      expectDecodedVideo(guestPage, '.stage-content-pane video'),
    ]);
    await expect(ownerPage.locator('.stage-content-pane').getByRole('button', { name: `Focus ${guestShareName}’s screen` })).toBeVisible();
    await ownerPage.screenshot({ path: '.local/two-screen-shares.png', fullPage: true });
    await callControl(guestPage, 'Stop sharing');
    await expect(ownerPage.locator('.stage-content-pane')).toHaveCount(1);

    await guestPage.locator('[aria-label="Adjust participant volume"]').click();
    await expect(guestPage.getByText(/4 media tracks/i)).toBeVisible();
    await ownerPage.waitForTimeout(1_500);
    await callControl(ownerPage, 'Stop recording');
    await expect(ownerPage.getByText('Recording saved', { exact: true })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Open it', exact: true }).click();
    await ownerPage.locator('.library-open').click();
    await ownerPage.locator('.recording-exports summary').click();
    const downloads = ownerPage.locator('.recording-exports a');
    await expect.poll(() => downloads.count()).toBeGreaterThanOrEqual(3);
    await expect(ownerPage.locator('.recording-exports a[download="manifest.json"]')).toBeVisible();
    const mediaNames = await downloads.evaluateAll((links) => links.map((link) => link.getAttribute('download') ?? '').filter((name) => name !== 'manifest.json'));
    expect(mediaNames.length).toBeGreaterThanOrEqual(2);
    expect(mediaNames.every((name) => /\.(webm|ogg|mp4)$/.test(name))).toBeTruthy();

    const manifestLink = ownerPage.locator('.recording-exports a[download="manifest.json"]');
    await expect(manifestLink).toHaveAttribute('href', /^blob:/);
    const manifest = await manifestLink.evaluate(async (link: HTMLAnchorElement) => {
      const response = await fetch(link.href);
      return response.json() as Promise<{ tracks: Array<{ source: string; status: string; bytes: number }> }>;
    });
    expect(manifest.tracks.length).toBeGreaterThanOrEqual(2);
    expect(manifest.tracks.some((track) => track.source === 'microphone' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'camera' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'screen' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();
    expect(manifest.tracks.some((track) => track.source === 'system' && track.status === 'complete' && track.bytes > 0)).toBeTruthy();

    await ownerPage.getByRole('button', { name: `Back to the call in ${room.name}`, exact: true }).click();
    await callControl(ownerPage, 'Stop sharing');
    await expect(guestPage.locator('.video-viewport video')).toHaveCount(0);
    await expect(guestPage.getByText(/2 media tracks/i)).toBeVisible();
    await callControl(ownerPage, 'Turn off camera');
    await expect(guestPage.locator('.camera-tile:not(.self) video')).toHaveCount(0);
    await callControl(ownerPage, 'Leave call');
    await expect(guestPage.locator('.camera-tile:not(.self):not(.invite)')).toHaveCount(0);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});
