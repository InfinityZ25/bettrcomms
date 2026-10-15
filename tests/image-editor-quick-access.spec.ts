import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Room = { id: string; name: string };
type Attachment = { id: string; filename: string; content_type: string };
type Message = { id: string; body: string; attachments?: Attachment[] };

async function value<T>(
  response: Pick<APIResponse, 'ok' | 'text' | 'json'>,
): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, suffix: string) {
  const deadline = Date.now() + 65_000;
  for (;;) {
    const response = await context.request.post('/api/v1/auth/dev', {
      headers,
      data: {
        name,
        email: `quick-${name.replace(/[^a-z]/gi, '')}-${suffix}@example.test`,
      },
    });
    if (response.status() !== 429 || Date.now() >= deadline)
      return (await value<{ user: User }>(response)).user;
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function room(context: BrowserContext, name: string) {
  return (
    await value<{ room: Room }>(
      await context.request.post('/api/v1/rooms', { headers, data: { name } }),
    )
  ).room;
}

async function enter(page: Page, selected: Room) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await page.getByRole('button', { name: selected.name, exact: true }).click();
  return page.getByRole('textbox', {
    name: `Message ${selected.name}`,
    exact: true,
  });
}

async function fixture(page: Page) {
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#5577cc';
      context.fillRect(0, 0, 96, 64);
      context.fillStyle = '#33aa77';
      context.fillRect(0, 35, 5, 5);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  // A valid ancillary chunk ensures the export is a newly flattened raster,
  // rather than the original file with a visual overlay or preserved metadata.
  const text = Buffer.from(
    'Comment\0private-original-fixture-metadata',
    'utf8',
  );
  const typed = Buffer.concat([Buffer.from('tEXt'), text]);
  let crc = 0xffffffff;
  for (const byte of typed) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([
    png.subarray(0, -12),
    size,
    typed,
    checksum,
    png.subarray(-12),
  ]);
}

async function attach(
  page: Page,
  bytes: Buffer,
  name = 'private-original.png',
  scope: Page | Locator = page,
) {
  await scope
    .getByLabel('Choose attachments', { exact: true })
    .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  return scope.getByLabel(`Pending attachment ${name}`, { exact: true });
}

async function rectangle(
  editor: Locator,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  for (const [name, next] of Object.entries({
    Left: left,
    Top: top,
    Width: width,
    Height: height,
  }))
    await editor
      .getByRole('spinbutton', { name, exact: true })
      .fill(String(next));
}

async function dimensions(image: Locator) {
  return image.evaluate((element) => {
    const image = element as HTMLImageElement;
    return image.complete ? [image.naturalWidth, image.naturalHeight] : [];
  });
}

test('image editing stays local and sends only the cropped rotated redacted PNG', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ baseURL });
  let selected: Room | undefined;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Image Editor', suffix);
    selected = await room(context, `Editor lab ${suffix}`);
    const page = await context.newPage();
    const composer = await enter(page, selected);
    await composer.fill('Image caption stays here');
    const original = await fixture(page);
    const writes: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== 'GET' &&
        new RegExp(
          `/rooms/${selected!.id}/(?:attachments|uploads|messages)(?:/|$)`,
        ).test(pathname)
      )
        writes.push(pathname);
    });
    const pending = await attach(page, original);
    await pending
      .getByRole('button', {
        name: 'Edit image private-original.png',
        exact: true,
      })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Edit image',
      exact: true,
    });
    await expect(
      editor.getByRole('button', { name: 'Use edited image', exact: true }),
    ).toBeEnabled();
    await page.keyboard.press('Control+k');
    await expect(
      page.getByRole('dialog', { name: 'Quick access', exact: true }),
    ).toBeHidden();
    await editor.getByRole('button', { name: 'Crop', exact: true }).click();
    await rectangle(editor, 0, 0, 60, 40);
    await editor
      .getByRole('button', { name: 'Apply crop', exact: true })
      .click();
    await editor
      .getByRole('button', { name: 'Rotate clockwise', exact: true })
      .click();
    await editor.getByRole('button', { name: 'Redact', exact: true }).click();
    await rectangle(editor, 8, 10, 12, 16);
    await editor
      .getByRole('button', { name: 'Add redaction', exact: true })
      .click();
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    await editor.getByRole('button', { name: 'Redo', exact: true }).click();
    await editor.getByRole('button', { name: 'Draw', exact: true }).click();
    const canvas = editor.getByLabel('Image editing canvas', { exact: true });
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(
      bounds!.x + bounds!.width / 40,
      bounds!.y + bounds!.height / 3,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds!.x + bounds!.width * 0.8,
      bounds!.y + bounds!.height / 3,
      { steps: 10 },
    );
    await page.mouse.up();
    await editor.screenshot({
      path: '.local/image-editor-quick-access-20261015/editor-desktop.png',
    });
    await editor
      .getByRole('button', { name: 'Use edited image', exact: true })
      .click();
    await expect(editor).toBeHidden();
    const edited = page.getByLabel(
      'Pending attachment private-original-edited.png',
      { exact: true },
    );
    await expect
      .poll(() => dimensions(edited.getByRole('img')))
      .toEqual([40, 60]);
    await expect(composer).toHaveValue('Image caption stays here');
    expect(writes).toEqual([]);
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/v1/rooms/${selected!.id}/messages`,
    );
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const message = (await value<{ message: Message }>(await sent)).message;
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments![0];
    expect(attachment.filename).toBe('private-original-edited.png');
    expect(attachment.content_type).toBe('image/png');
    const authorized = await value<{ url: string }>(
      await context.request.get(
        `/api/v1/rooms/${selected.id}/attachments/${attachment.id}?link=1`,
      ),
    );
    const response = await context.request.get(authorized.url);
    expect(response.ok()).toBe(true);
    const received = await response.body();
    expect(received.equals(original)).toBe(false);
    expect(
      received.includes(Buffer.from('private-original-fixture-metadata')),
    ).toBe(false);
    const actual = await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: 'image/png' }),
      );
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return {
          size: [bitmap.width, bitmap.height],
          redacted: Array.from(context.getImageData(10, 20, 1, 1).data),
          kept: Array.from(context.getImageData(2, 2, 1, 1).data),
          drawn: Array.from(context.getImageData(28, 20, 1, 1).data),
        };
      } finally {
        bitmap.close();
      }
    }, received.toString('base64'));
    expect(actual).toMatchObject({
      size: [40, 60],
      redacted: [0, 0, 0, 255],
      kept: [51, 170, 119, 255],
    });
    expect(actual.drawn).not.toEqual([85, 119, 204, 255]);
    expect(actual.drawn[3]).toBe(255);
  } finally {
    if (selected)
      await context.request.delete(`/api/v1/rooms/${selected.id}`, { headers });
    await context.close();
  }
});

test('image Cancel keeps the original and the editor also works in a mobile thread', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 375, height: 812 },
  });
  let selected: Room | undefined;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Mobile Editor', suffix);
    selected = await room(context, `Mobile editing ${suffix}`);
    const root = (
      await value<{ message: Message }>(
        await context.request.post(`/api/v1/rooms/${selected.id}/messages`, {
          headers,
          data: {
            body: 'Open this image thread',
            client_nonce: crypto.randomUUID(),
          },
        }),
      )
    ).message;
    const page = await context.newPage();
    await enter(page, selected);
    await page
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole('button', { name: 'Open thread', exact: true })
      .click();
    const thread = page.getByRole('complementary', {
      name: 'Message thread',
      exact: true,
    });
    const original = await fixture(page);
    const pending = await attach(page, original, 'thread-image.png', thread);
    await pending
      .getByRole('button', { name: 'Edit image thread-image.png', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Edit image',
      exact: true,
    });
    await expect(
      editor.getByRole('button', { name: 'Use edited image', exact: true }),
    ).toBeEnabled();
    await editor
      .getByRole('button', { name: 'Rotate clockwise', exact: true })
      .click();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect
      .poll(() => dimensions(pending.getByRole('img')))
      .toEqual([96, 64]);
    await pending
      .getByRole('button', { name: 'Edit image thread-image.png', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: 'Use edited image', exact: true }),
    ).toBeEnabled();
    await editor
      .getByRole('button', { name: 'Rotate clockwise', exact: true })
      .click();
    const overflow = await editor.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    await editor.screenshot({
      path: '.local/image-editor-quick-access-20261015/editor-mobile.png',
    });
    const toolbarButtons = editor.getByRole('button', {
      name: /^(Crop|Rotate clockwise|Draw|Arrow|Redact|Undo|Redo|Reset image|Cancel|Use edited image)$/,
    });
    for (const button of await toolbarButtons.all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await editor
      .getByRole('button', { name: 'Use edited image', exact: true })
      .click();
    const edited = thread.getByLabel(
      'Pending attachment thread-image-edited.png',
      { exact: true },
    );
    await expect
      .poll(() => dimensions(edited.getByRole('img')))
      .toEqual([64, 96]);
    await thread
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      thread
        .getByRole('log', { name: 'Thread replies', exact: true })
        .getByRole('button', { name: /Open thread-image-edited.png/ }),
    ).toBeVisible();
  } finally {
    if (selected)
      await context.request.delete(`/api/v1/rooms/${selected.id}`, { headers });
    await context.close();
  }
});

test('Ctrl K navigates settings and friends without losing drafts or interrupting a call', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ baseURL });
  const friendContext = await browser.newContext({ baseURL });
  let selected: Room | undefined;
  let releaseDirect = () => {};
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Quick Owner', suffix);
    const friend = await login(friendContext, `Álvaro ${suffix}`, suffix);
    const request = (
      await value<{ request: { id: string } }>(
        await context.request.post('/api/v1/friends/requests', {
          headers,
          data: { user_id: friend.id },
        }),
      )
    ).request;
    await value(
      await friendContext.request.post(
        `/api/v1/friends/requests/${request.id}/accept`,
        { headers, data: {} },
      ),
    );
    selected = await room(context, `Quick original ${suffix}`);
    const page = await context.newPage();
    const composer = await enter(page, selected);
    await composer.fill('Keep my unsent text');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', {
      name: 'Quick access',
      exact: true,
    });
    const input = palette.getByRole('combobox', {
      name: 'Find a friend, channel or setting',
      exact: true,
    });
    await expect(input).toBeFocused();
    await input.fill(`not-present-${suffix}`);
    await expect(palette.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Keep my unsent text');
    await page.keyboard.press('Meta+k');
    await input.fill('audio');
    await input.press('ArrowDown');
    await input.press('Enter');
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true,
    });
    await expect(
      settings.getByRole('heading', { name: 'Call audio', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(palette).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await composer.focus();
    await page.keyboard.press('Control+Shift+f');
    await expect(
      page.getByRole('searchbox', { name: 'Search messages', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join voice', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    await input.fill(`alvaro ${suffix}`);
    const directResponseReleased = new Promise<void>((resolve) => {
      releaseDirect = resolve;
    });
    await page.route('**/api/v1/rooms/direct', async (route) => {
      const response = await route.fetch();
      await directResponseReleased;
      await route.fulfill({ response });
    });
    // The real API publishes rooms.changed before the POST ACK. Hold that ACK
    // until an authorized-list refresh proves the revision arrived.
    const refreshedRooms = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/rooms',
    );
    const friendOption = palette
      .getByRole('option')
      .filter({ hasText: friend.name });
    await expect(friendOption).toBeVisible();
    await friendOption.click();
    await refreshedRooms;
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(`alvaro ${suffix}`);
    releaseDirect();
    await expect(palette).toBeHidden();
    await expect(
      page.getByRole('region', {
        name: `Conversation with ${friend.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    await input.fill(selected.name);
    await palette
      .getByRole('option')
      .filter({ hasText: selected.name })
      .filter({ hasText: 'Text and voice' })
      .click();
    await expect(
      page.getByRole('textbox', {
        name: `Message ${selected.name}`,
        exact: true,
      }),
    ).toHaveValue('Keep my unsent text');
    await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  } finally {
    if (selected)
      await context.request.delete(`/api/v1/rooms/${selected.id}`, { headers });
    releaseDirect();
    await Promise.allSettled([context.close(), friendContext.close()]);
  }
});

test('permission changes close image editing and refresh mobile quick access without stale channels', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(owner, 'Editor Access Owner', suffix);
    const user = await login(member, 'Editor Access Member', suffix);
    const friendRequest = (
      await value<{ request: { id: string } }>(
        await owner.request.post('/api/v1/friends/requests', {
          headers,
          data: { user_id: user.id },
        }),
      )
    ).request;
    await value(
      await member.request.post(
        `/api/v1/friends/requests/${friendRequest.id}/accept`,
        { headers, data: {} },
      ),
    );
    const community = (
      await value<{
        community: { id: string; name: string; channels: Room[] };
      }>(
        await owner.request.post('/api/v1/communities', {
          headers,
          data: { name: `Quick privacy ${suffix}` },
        }),
      )
    ).community;
    communityId = community.id;
    await value(
      await owner.request.post(`/api/v1/communities/${communityId}/members`, {
        headers,
        data: { user_id: user.id },
      }),
    );
    const channel = community.channels[0];
    const accessPath = `/api/v1/communities/${communityId}/channels/${channel.id}/permissions`;
    const page = await member.newPage();
    const composer = await enter(page, channel);
    const pending = await attach(page, await fixture(page), 'access-image.png');
    await pending
      .getByRole('button', { name: 'Edit image access-image.png', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Edit image',
      exact: true,
    });
    await expect(
      editor.getByRole('button', { name: 'Use edited image', exact: true }),
    ).toBeEnabled();
    await value(
      await owner.request.put(accessPath, {
        headers,
        data: {
          is_private: false,
          overrides: [{ subject_key: 'member', permissions: { post: 'deny' } }],
        },
      }),
    );
    await expect(editor).toBeHidden();
    await value(
      await owner.request.put(accessPath, {
        headers,
        data: { is_private: false, overrides: [] },
      }),
    );
    await expect(composer).toBeEditable();
    await expect(
      pending.getByRole('button', {
        name: 'Edit image access-image.png',
        exact: true,
      }),
    ).toBeEnabled();
    await expect(editor).toBeHidden();
    await page.setViewportSize({ width: 375, height: 812 });
    await page
      .getByRole('button', { name: 'Quick access', exact: true })
      .click();
    const palette = page.getByRole('dialog', {
      name: 'Quick access',
      exact: true,
    });
    const input = palette.getByRole('combobox', {
      name: 'Find a friend, channel or setting',
      exact: true,
    });
    await input.fill(community.name);
    const results = palette
      .getByRole('option')
      .filter({ hasText: community.name });
    await expect(results.first()).toBeVisible();
    await value(
      await owner.request.put(accessPath, {
        headers,
        data: { is_private: true, overrides: [] },
      }),
    );
    await expect(results).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(community.name);
    await value(
      await owner.request.put(accessPath, {
        headers,
        data: { is_private: false, overrides: [] },
      }),
    );
    await expect(results.first()).toBeVisible();
    expect(
      await palette.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ),
    ).toBe(false);
    for (const option of await results.all()) {
      const bounds = await option.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await palette.screenshot({
      path: '.local/image-editor-quick-access-20261015/palette-mobile.png',
    });
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', {
        name: `${user.name} and account options`,
        exact: true,
      })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enter local workspace', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(palette).toBeHidden();
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await Promise.allSettled([owner.close(), member.close()]);
  }
});
