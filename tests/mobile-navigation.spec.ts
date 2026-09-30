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

test('mobile sidebar overlays the call and closes after choosing a room', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 650 },
  });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Nav', `mobile-nav-${suffix}@example.test`);
    const room = (
      await json<{ room: { name: string } }>(
        await context.request.post('/api/v1/rooms', {
          headers: { Origin: origin },
          data: { name: `Mobile room ${suffix}` },
        }),
      )
    ).room;
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: room.name })).toBeVisible();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(
      page.getByRole('button', { name: 'Leave call' }),
    ).toBeVisible();
    const main = page.locator('main');
    const before = await main.boundingBox();
    // Portrait phones navigate from a bottom tab bar; Calls opens the room list.
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    const tabBar = await tabs.boundingBox();
    expect(tabBar!.width).toBe(390);
    expect(tabBar!.y + tabBar!.height).toBeCloseTo(650, 0);
    await tabs.getByRole('button', { name: 'Calls' }).click();
    const drawer = page.getByRole('dialog', { name: 'Conversations' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toBeInViewport({ ratio: 0.9 });
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(390 * 0.85, 0);
    expect((await main.boundingBox())?.width).toBe(before?.width);
    await page.screenshot({ path: '.local/mobile-sidebar-drawer.png' });
    await drawer.getByRole('button', { name: room.name }).click();
    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Leave call' }),
    ).toBeVisible();

    await tabs.getByRole('button', { name: 'Calls' }).click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // The 768–820px range must use the same drawer as narrower phones.
    await page.setViewportSize({ width: 800, height: 650 });
    await tabs.getByRole('button', { name: 'Calls' }).click();
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBeCloseTo(384, 0);
    await page.keyboard.press('Escape');

    // A phone on its side is wider than 820px but still gets the drawer, not
    // a sidebar beside the call.
    await page.setViewportSize({ width: 852, height: 393 });
    await expect(drawer).toBeHidden();
    // Only the section rail sits beside the call.
    await expect
      .poll(async () => (await main.boundingBox())!.width)
      .toBeGreaterThan(852 - 80);
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(drawer).toBeVisible();
  } finally {
    await context.close();
  }
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
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Friends', exact: true })
      .click();
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
    await desk.getByRole('button', { name: room.name }).first().click();
    await desk.getByRole('button', { name: 'Join call' }).click();
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
    await page.getByRole('button', { name: 'Join call' }).click();
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

    // Room chat covers the call on a phone, so it offers its own way back.
    await page.getByRole('button', { name: 'More call options' }).click();
    await page.getByRole('menuitem', { name: 'Chat' }).click();
    await expect(page.getByRole('region', { name: 'Room chat' })).toBeVisible();
    // Nothing from the call sits on top of the composer.
    const composer = (await page
      .getByRole('region', { name: 'Room chat' })
      .getByRole('textbox')
      .boundingBox())!;
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[aria-label="Room chat"]') !==
        null,
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
    await expect(
      message.getByRole('button', { name: 'Add reaction', exact: true }),
    ).toBeHidden();
    await message.getByText('Touch actions regression', { exact: true }).tap();
    await expect(
      message.getByRole('button', { name: 'Add reaction', exact: true }),
    ).toBeVisible();
    await expect(
      message.getByRole('button', {
        name: `Reply to ${caller.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close room messages' }).click();
    await expect(page.getByRole('region', { name: 'Room chat' })).toBeHidden();
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
      hasTouch: true,
      isMobile: true,
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
      await page.setViewportSize({ width: 375, height: 667 });
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('button', { name: 'Messages', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Conversations' })
        .getByRole('button', { name: other.name, exact: true })
        .click();
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
      const conversation = page.getByRole('region', {
        name: `Conversation with ${other.name}`,
        exact: true,
      });
      await expect(conversation).toBeHidden();
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
