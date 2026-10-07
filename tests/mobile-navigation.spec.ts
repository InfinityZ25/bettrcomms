import { openMobileFriends } from './mobile-touch';
import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
} from '@playwright/test';

type User = { id: string; name: string };
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const origin = new URL(baseURL).origin;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok())
    throw new Error(`API ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function login(
  context: BrowserContext,
  name: string,
  email: string,
): Promise<User> {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', {
      headers: { Origin: origin },
      data: { name, email },
    });
    if (response.status() !== 429 || Date.now() >= deadline) {
      const value = await json<User | { user: User }>(response);
      return 'user' in value ? value.user : value;
    }
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

test('mobile sections open full-screen lists without interrupting an active call', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 650 }, hasTouch: true, isMobile: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Nav', `mobile-nav-${suffix}@example.test`);
    const room = (await json<{ room: { name: string } }>(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Mobile room ${suffix}` },
    }))).room;
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Join voice' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    for (const size of [{width:390,height:650}, {width:800,height:650}, {width:852,height:393}]) {
      await page.setViewportSize(size);
      await expect(tabs.getByRole('button', { name: 'Friends', exact: true })).toBeHidden();
      if (size.width <= 820) await expect(tabs.getByRole('button')).toHaveCount(4);
      await tabs.getByRole('button', { name: 'Rooms', exact: true }).click();
      const list = page.getByRole('main', { name: 'Rooms', exact: true });
      await expect(list).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Conversations' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
      const box = (await list.boundingBox())!;
      expect(box.width).toBeGreaterThan(size.width - 80);
      await list.getByRole('button', { name: room.name, exact: true }).click();
      await expect(list).toBeHidden();
      await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
    }
    await page.screenshot({ path: '.local/mobile-ui-review/mobile-call.png' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(tabs.getByRole('button', { name: 'Friends', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();
  } finally { await context.close(); }
});

test('friends dialog stays within a short phone viewport and scrolls to its actions', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 480 },
  });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(
      context,
      'Mobile Friends',
      `mobile-friends-${suffix}@example.test`,
    );
    const page = await context.newPage();
    await page.goto('/');
    await openMobileFriends(page);
    const dialog = page.getByRole('dialog', { name: 'Better with friends' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(480);
    await expect(
      dialog.getByRole('button', { name: 'Close' }),
    ).toBeInViewport();
    await page.screenshot({ path: '.local/mobile-friends-dialog.png' });
    const addById = dialog.getByText('Add by user ID');
    await addById.scrollIntoViewIfNeeded();
    await expect(addById).toBeInViewport();
    await addById.click();
    await dialog
      .getByRole('button', { name: 'Send request' })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole('button', { name: 'Send request' }),
    ).toBeInViewport();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
});

test('a phone call keeps every control in one row below cameras that fill the screen', async ({
  browser,
}) => {
  const phone = await browser.newContext({
    baseURL,
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });
  const friend = await browser.newContext({ baseURL });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const caller = await login(
      phone,
      'Phone Caller Identity',
      `phone-id-${suffix}@example.test`,
    );
    const other = await login(
      friend,
      'Desk Friend',
      `desk-friend-${suffix}@example.test`,
    );
    const request = await json<{ request: { id: string } }>(
      await phone.request.post('/api/v1/friends/requests', {
        headers: { Origin: origin },
        data: { user_id: other.id },
      }),
    );
    await json(
      await friend.request.post(
        `/api/v1/friends/requests/${request.request.id}/accept`,
        { headers: { Origin: origin }, data: {} },
      ),
    );
    const room = (
      await json<{ room: { id: string; name: string } }>(
        await phone.request.post('/api/v1/rooms', {
          headers: { Origin: origin },
          data: { name: `Phone call ${suffix}` },
        }),
      )
    ).room;
    await json(
      await phone.request.post(`/api/v1/rooms/${room.id}/members`, {
        headers: { Origin: origin },
        data: { user_id: other.id },
      }),
    );

    const page = await phone.newPage();
    const desk = await friend.newPage();
    await Promise.all([page.goto('/'), desk.goto('/')]);
    await desk.getByRole('button', { name: room.name, exact: true }).first().click();
    await desk.getByRole('button', { name: 'Join voice' }).click();
    await page.evaluate(() => {
      localStorage.setItem(
        'bc-push-to-talk',
        JSON.stringify({
          enabled: true,
          binding: { kind: 'keyboard', code: 'Space' },
        }),
      );
      window.dispatchEvent(new Event('bc-push-to-talk'));
    });
    await page.getByRole('button', { name: 'Join voice' }).click();
    await expect(
      page.getByRole('button', { name: 'Leave call' }),
    ).toBeVisible();
    await expect(page.locator('.camera-tile')).toHaveCount(2);
    await expect(page.locator('.push-to-talk-status')).toBeVisible();

    const buttons = [
      'Mute microphone',
      'Deafen call',
      'Turn on camera',
      'More call options',
      'Leave call',
    ];
    const boxes = await Promise.all(
      buttons.map(
        async (name) =>
          (await page
            .getByRole('button', { name, exact: true })
            .boundingBox())!,
      ),
    );
    // One row, thumb-sized, inside the screen.
    for (const box of boxes) {
      expect(Math.round(box.y)).toBe(Math.round(boxes[0].y));
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    // The cameras end above the controls and share the height between them.
    const tiles = await page
      .locator('.camera-tile')
      .evaluateAll((elements) =>
        elements.map(
          (element) => element.getBoundingClientRect().toJSON() as DOMRect,
        ),
      );
    for (const tile of tiles) {
      expect(tile.bottom).toBeLessThanOrEqual(boxes[0].y);
      expect(tile.height).toBeGreaterThan(200);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(375);

    // The source picker belongs in More: six 44px controls still fit at 320px,
    // with connection and push-to-talk status in a separate row.
    await page.setViewportSize({ width: 320, height: 667 });
    for (const name of [...buttons, 'Share screen']) {
      const box = (await page
        .getByRole('button', { name, exact: true })
        .boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    await page.setViewportSize({ width: 375, height: 667 });

    // Recording and layout live in the overflow menu.
    await page.getByRole('button', { name: 'More call options' }).click();
    await expect(
      page.getByRole('menuitem', { name: 'Record separate tracks' }),
    ).toBeVisible();
    await page.getByRole('menuitem', { name: 'Camera source' }).click();
    await expect(
      page.getByRole('menuitemradio', { name: 'System default' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Channel chat covers the call on a phone, so it offers its own way back.
    await page.getByRole('button', { name: 'More call options' }).click();
    await page.getByRole('menuitem', { name: 'Chat' }).click();
    const chat = page.getByRole('region', {
      name: `${room.name} · ${room.name}`,
      exact: true,
    });
    await expect(chat).toBeVisible();
    // Nothing from the call sits on top of the composer.
    const composer = (await chat.getByRole('textbox').boundingBox())!;
    const hit = await chat.evaluate(
      (conversation, { x, y }) => {
        const target = document.elementFromPoint(x, y);
        return target !== null && conversation.contains(target);
      },
      {
        x: composer.x + composer.width / 2,
        y: composer.y + composer.height / 2,
      },
    );
    expect(hit).toBe(true);
    await json(
      await phone.request.post(`/api/v1/rooms/${room.id}/messages`, {
        headers: { Origin: origin },
        data: {
          body: 'Touch actions regression',
          client_nonce: crypto.randomUUID(),
        },
      }),
    );
    const message = page
      .locator('article')
      .filter({ hasText: 'Touch actions regression' });
    await expect(message).toBeVisible();
    const before = (await message.boundingBox())!;
    await message.getByText('Touch actions regression', { exact: true }).tap();
    expect((await message.boundingBox())!.height).toBeCloseTo(before.height, 0);
    await message.getByRole('button', { name: `Message options for ${caller.name}`, exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Add reaction', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await chat.getByRole('button', { name: 'Back to call', exact: true }).click();
    await expect(chat).toBeHidden();
    await page.screenshot({ path: '.local/mobile-call.png' });
  } finally {
    await phone.close();
    await friend.close();
  }
});

for (const initialWidth of [375, 1280]) {
  test(`direct-call chat follows resizing until explicitly chosen (loaded at ${initialWidth}px)`, async ({
    browser,
  }) => {
    const phone = await browser.newContext({
      baseURL,
      viewport: { width: initialWidth, height: 667 },
      hasTouch: initialWidth === 375,
      isMobile: initialWidth === 375,
    });
    const friend = await browser.newContext({ baseURL });
    try {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await login(phone, 'Phone Direct', `phone-direct-${suffix}@example.test`);
      const other = await login(
        friend,
        'Phone Friend',
        `phone-friend-${suffix}@example.test`,
      );
      const request = await json<{ request: { id: string } }>(
        await phone.request.post('/api/v1/friends/requests', {
          headers: { Origin: origin },
          data: { user_id: other.id },
        }),
      );
      await json(
        await friend.request.post(
          `/api/v1/friends/requests/${request.request.id}/accept`,
          { headers: { Origin: origin }, data: {} },
        ),
      );
      await json(
        await phone.request.post('/api/v1/rooms/direct', {
          headers: { Origin: origin },
          data: { user_id: other.id },
        }),
      );
      await phone.addInitScript(() => {
        Object.defineProperty(document, 'fullscreenEnabled', {
          configurable: true,
          value: undefined,
        });
        Object.defineProperty(Element.prototype, 'requestFullscreen', {
          configurable: true,
          value: undefined,
        });
      });
      const page = await phone.newPage();
      await page.goto('/');
      await page.getByRole('button', { name: 'Messages', exact: true }).click();
      await page.getByRole('button', { name: other.name, exact: true }).click();
      await page
        .getByRole('region', {
          name: `Conversation with ${other.name}`,
          exact: true,
        })
        .getByRole('button', { name: 'Call', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
      const conversation = page.getByRole('main', { name: 'Call', exact: true }).getByRole('region', {
        name: `Conversation with ${other.name}`,
        exact: true,
      });
      if (initialWidth === 1280) await expect(conversation).toBeVisible();
      else await expect(conversation).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(conversation).toBeVisible();
      await page.setViewportSize({ width: 375, height: 667 });
      await expect(conversation).toBeHidden();
      await page.getByRole('button', { name: 'More call options' }).click();
      await expect(
        page.getByRole('menuitem', { name: 'Fullscreen', exact: true }),
      ).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'Chat', exact: true }).click();
      await expect(conversation).toBeVisible();
      // An explicit open survives widening and returning to the phone layout.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(conversation).toBeVisible();
      await page.setViewportSize({ width: 375, height: 667 });
      await expect(conversation).toBeVisible();
      await page
        .getByRole('button', { name: 'Back to call', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Back to call', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
      // Back to call was an explicit close: resizing must not reopen chat.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(conversation).toBeHidden();
    } finally {
      await phone.close();
      await friend.close();
    }
  });
}

// The installed iPhone app's boot report: iOS-only code paths run, and the
// host-dependent ones fail as they would without the native side, which is
// what raises the notice this test checks the placement of.
const iosBoot = (() => {
  const unavailable = { state: 'unavailable', detail: 'test', fallback: 'browser' };
  return {
    schemaVersion: 1, runtime: 'wails', hostVersion: 'test', platform: 'ios', architecture: 'arm64',
    apiOrigin: '', authReturn: unavailable,
    windowControls: { platform: 'ios', mode: 'native-frame', height: 0, insetStart: 0, insetEnd: 0, buttons: [], buttonSide: 'end' },
    capabilities: {
      schemaVersion: 1, platform: 'ios', architecture: 'arm64', browserMedia: { state: 'implemented', detail: 'test' },
      nativeGameVideo: unavailable, nativeProcessAudio: unavailable, nativeMicrophoneDsp: unavailable,
      localTrackRecording: unavailable, mediaPermissions: unavailable, globalInput: unavailable,
      nativeOverlays: unavailable, notes: [],
    },
  };
})();

test('the iPhone app keeps notices clear of call controls and uses full-screen sheets', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'iPhone Owner', `iphone-owner-${suffix}@example.test`);
    const room = (await json<{ room: { name: string } }>(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `iPhone room ${suffix}` },
    }))).room;
    await context.addInitScript((boot) => { Object.assign(window, { __BETTERCOMMS_DESKTOP__: boot }); }, iosBoot);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: room.name })).toBeVisible();
    await page.getByRole('button', { name: 'Join voice' }).click();
    await expect(page.getByRole('button', { name: 'Leave call' })).toBeVisible();

    // Without the native side the app reports its missing background audio.
    const notice = page.getByRole('alert');
    await expect(notice).toBeVisible();
    const dismissButton = notice.getByRole('button', { name: 'Dismiss notification' });
    // Measure once the entrance animation has settled at full scale.
    await expect.poll(async () => (await dismissButton.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    const box = (await notice.boundingBox())!;
    const leave = (await page.getByRole('button', { name: 'Leave call' }).boundingBox())!;
    expect(box.width).toBeGreaterThan(402 * 0.85);
    expect(box.y).toBeLessThan(874 / 3);
    expect(box.y + box.height).toBeLessThan(leave.y);

    // With no text status, the connection icon shares the controls' row.
    const connection = (await page.getByRole('button', { name: 'Connection diagnostics' }).boundingBox())!;
    expect(Math.abs(connection.y + connection.height / 2 - (leave.y + leave.height / 2))).toBeLessThan(4);
    await dismissButton.click();
    await expect(notice).toBeHidden();

    // Settings is a full-screen sheet on a phone.
    await page.getByRole('button', { name: /account options/ }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await expect.poll(async () => Math.round((await settings.boundingBox())!.width)).toBe(402);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    // A phone held sideways gets the same phone styles, not the desktop ones,
    // and keeps clear of the notch now at a side edge.
    await page.setViewportSize({ width: 874, height: 402 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 59, right: 59, bottom: 21 } });
    await page.getByRole('button', { name: /account options/ }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(settings).toBeVisible();
    await expect.poll(async () => Math.round((await settings.boundingBox())!.width)).toBe(874);
    const close = (await settings.getByRole('button', { name: 'Close' }).boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(874 - 59);
    const firstControl = (await settings.getByRole('combobox').or(settings.getByRole('button', { name: /Audio|Devices/ })).first().boundingBox())!;
    expect(firstControl.x).toBeGreaterThanOrEqual(59);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    // The narrowest supported phone, with no text status: the controls wrap
    // below the connection icon rather than being clipped off the edge.
    await page.setViewportSize({ width: 320, height: 640 });
    // Back to portrait insets: a small phone's status bar and no side notch,
    // so the check measures the full 320px width.
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20 } });
    for (const name of ['Mute microphone', 'More call options', 'Leave call']) {
      // Rotation updates safe areas and the visual viewport on separate
      // frames. Check the settled geometry rather than the preceding layout.
      const button = page.getByRole('button', { name, exact: true });
      await expect.poll(async () => (await button.boundingBox())!.x).toBeGreaterThanOrEqual(0);
      await expect.poll(async () => {
        const control = (await button.boundingBox())!;
        return control.x + control.width;
      }).toBeLessThanOrEqual(320);
    }
  } finally {
    await context.close();
  }
});

test('unsupported mobile screen sharing explains the limit inside the viewport', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 650 } });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Share', `mobile-share-${suffix}@example.test`);
    await json(await context.request.post('/api/v1/rooms', {
      headers: { Origin: origin }, data: { name: `Mobile share ${suffix}` },
    }));
    await context.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true, value: undefined,
      });
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Join voice' }).click();
    await expect(page.getByRole('button', { name: 'Share screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Share screen' }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'This browser cannot share its screen' });
    await expect(notice).toBeVisible();
    // On a phone the notice drops in from the top; measure it once settled.
    await expect.poll(async () => (await notice.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const box = await notice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(650);
    await expect(notice.getByRole('button', { name: 'Dismiss notification' })).toBeInViewport();
  } finally {
    await context.close();
  }
});
