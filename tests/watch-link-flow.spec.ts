import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
  type Route,
} from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
const videoURL = 'https://youtu.be/M7lc1UVf-VE';
const canonicalURL = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
type User = { id: string; name: string };
type Room = { id: string; name: string };
type Community = { id: string; name: string; channels: Room[] };
type Watch = {
  playback_id: string;
  source_kind: string;
  host_id: string;
  paused: boolean;
  youtube: { id: string; title: string };
};
type Queue = {
  viewers: number;
  items: { author_id: string; video: { id: string; title: string } }[];
};

async function value<T>(
  response: Pick<APIResponse, 'ok' | 'text' | 'json'>,
): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, suffix: string) {
  return (
    await value<{ user: User }>(
      await context.request.post('/api/v1/auth/dev', {
        headers,
        data: {
          name,
          email: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.test`,
        },
      }),
    )
  ).user;
}

async function setup(owner: BrowserContext, member: BrowserContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerUser = await login(owner, 'Watch Link Host', suffix);
  const memberUser = await login(member, 'Watch Link Friend', suffix);
  const { request } = await value<{ request: { id: string } }>(
    await owner.request.post('/api/v1/friends/requests', {
      headers,
      data: { user_id: memberUser.id },
    }),
  );
  await value(
    await member.request.post(`/api/v1/friends/requests/${request.id}/accept`, {
      headers,
      data: {},
    }),
  );
  const { community } = await value<{ community: Community }>(
    await owner.request.post('/api/v1/communities', {
      headers,
      data: { name: `Watch Link Friends ${suffix}` },
    }),
  );
  await value(
    await owner.request.post(`/api/v1/communities/${community.id}/members`, {
      headers,
      data: { user_id: memberUser.id },
    }),
  );
  return { community, ownerUser, memberUser, room: community.channels[0] };
}

async function enter(
  page: Page,
  community: Community,
  room = community.channels[0],
) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await page
    .getByRole('list', { name: `${community.name} channel list`, exact: true })
    .getByRole('button', { name: room.name, exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: `Message ${room.name}`, exact: true }),
  ).toBeVisible();
}

async function openWatch(page: Page) {
  await page
    .getByRole('button', { name: 'Channel activities', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Channel activities',
    exact: true,
  });
  await dialog
    .getByRole('group', { name: 'Activity views', exact: true })
    .getByRole('button', { name: 'Watch together', exact: true })
    .click();
  return dialog;
}

async function watch(context: BrowserContext, room: string) {
  return (
    await value<{ watch: Watch | null }>(
      await context.request.get(
        `/api/v1/rooms/${room}/activities?watch_sources=file,youtube`,
      ),
    )
  ).watch;
}

async function queue(context: BrowserContext, room: string) {
  return value<Queue>(
    await context.request.get(`/api/v1/rooms/${room}/watch-together/queue`),
  );
}

async function expectNoVoice(context: BrowserContext, room: string) {
  const presence = await value<{
    rooms: { room_id: string; participants: unknown[] }[];
  }>(await context.request.get('/api/v1/call-presence'));
  expect(
    presence.rooms.find((entry) => entry.room_id === room)?.participants,
  ).toEqual([]);
}

function trackWatch(page: Page, room: string) {
  const mutations: { method: string; path: string }[] = [];
  const providerRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith(`/api/v1/rooms/${room}/watch-together`) &&
      request.method() !== 'GET'
    )
      mutations.push({ method: request.method(), path: url.pathname });
    if (
      /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/.test(
        url.hostname,
      )
    )
      providerRequests.push(request.url());
  });
  return { mutations, providerRequests };
}

async function expectTouchTarget(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
}

test('a chat YouTube link opens a prefilled watch form and explicit watching preserves consent and host ownership', async ({
  browser,
}, testInfo) => {
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  let disposeInitialQueueGate: (() => Promise<void>) | undefined;
  try {
    const { community, ownerUser, memberUser, room } = await setup(
      owner,
      member,
    );
    communityId = community.id;
    const config = await value<{
      watch_together: { youtube_enabled: boolean };
    }>(await owner.request.get('/api/v1/config'));
    expect(
      config.watch_together.youtube_enabled,
      'Run with a configured isolated YouTube helper origin.',
    ).toBe(true);
    const negative: { id: string }[] = [];
    for (const body of [
      `||${videoURL}||`,
      `\`${videoURL}\``,
      'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE',
    ]) {
      negative.push(
        (
          await value<{ message: { id: string } }>(
            await owner.request.post(`/api/v1/rooms/${room.id}/messages`, {
              headers,
              data: { body },
            }),
          )
        ).message,
      );
    }
    const first = await owner.newPage();
    const second = await member.newPage();
    const hostRequests = trackWatch(first, room.id);
    const memberRequests = trackWatch(second, room.id);
    await enter(first, community);
    await enter(second, community);
    for (const message of negative) {
      await expect(
        first
          .locator(`[data-message-id="${message.id}"]`)
          .getByRole('button', { name: 'Watch together', exact: true }),
      ).toHaveCount(0);
    }

    await first
      .getByRole('textbox', { name: `Message ${room.name}`, exact: true })
      .fill(videoURL);
    const sent = first.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/rooms/${room.id}/messages` &&
        response.request().method() === 'POST',
    );
    await first
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const { message } = await value<{ message: { id: string } }>(await sent);
    const row = first.locator(`[data-message-id="${message.id}"]`);
    await expect(
      second.locator(`[data-message-id="${message.id}"]`),
    ).toContainText(videoURL);
    await expect(
      first.getByRole('dialog', { name: 'Channel activities', exact: true }),
    ).toHaveCount(0);
    expect(await watch(owner, room.id)).toBeNull();
    expect((await queue(owner, room.id)).viewers).toBe(0);
    expect(hostRequests.mutations).toEqual([]);

    await row
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    const host = first.getByRole('dialog', {
      name: 'Channel activities',
      exact: true,
    });
    const hostQueue = host.getByRole('region', {
      name: 'YouTube watch queue',
      exact: true,
    });
    const input = hostQueue.getByLabel('Add a YouTube video or Short', {
      exact: true,
    });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(canonicalURL);
    await expect(
      hostQueue.getByRole('button', { name: 'Join Watch', exact: true }),
    ).toBeVisible();
    await expect(
      hostQueue.getByRole('button', { name: 'Watch together', exact: true }),
    ).toBeEnabled();
    expect((await queue(owner, room.id)).viewers).toBe(0);
    expect(hostRequests.mutations).toEqual([]);
    expect(hostRequests.providerRequests).toEqual([]);
    await expect(first.locator('iframe')).toHaveCount(0);
    await expectNoVoice(owner, room.id);

    await first.setViewportSize({ width: 375, height: 812 });
    await expectTouchTarget(input);
    await expectTouchTarget(
      hostQueue.getByRole('button', { name: 'Join Watch', exact: true }),
    );
    await expectTouchTarget(
      hostQueue.getByRole('button', { name: 'Watch together', exact: true }),
    );
    const overflow = await first.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect((await host.boundingBox())!.width).toBeLessThanOrEqual(375);
    await first.screenshot({
      path: testInfo.outputPath('watch-link-prefilled-mobile.png'),
    });

    await input.fill('https://example.test/video');
    await hostQueue
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    await expect(hostQueue.getByRole('alert')).toContainText(
      'Paste a YouTube video or Shorts HTTPS link.',
    );
    expect(hostRequests.mutations).toEqual([]);
    expect((await queue(owner, room.id)).viewers).toBe(0);
    await input.fill(canonicalURL);
    await hostQueue
      .getByLabel('Title (optional)', { exact: true })
      .fill('Shared API demo');
    await hostQueue
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    await expect
      .poll(async () => (await watch(owner, room.id))?.youtube.id)
      .toBe('M7lc1UVf-VE');
    const playback = (await watch(owner, room.id))!;
    expect(playback).toMatchObject({
      source_kind: 'youtube',
      host_id: ownerUser.id,
      paused: true,
    });
    expect(playback.playback_id).toBeTruthy();
    await expect
      .poll(async () => (await queue(owner, room.id)).viewers)
      .toBe(1);
    await expect(
      hostQueue.getByRole('button', { name: /Allow YouTube/ }),
    ).toBeVisible();
    expect(hostRequests.mutations.map((request) => request.path)).toContain(
      `/api/v1/rooms/${room.id}/watch-together/next`,
    );
    await expect(first.locator('iframe')).toHaveCount(0);
    expect(hostRequests.providerRequests).toEqual([]);
    await expectNoVoice(owner, room.id);

    const queuePath = `/api/v1/rooms/${room.id}/watch-together/queue`;
    const queuePattern = `**${queuePath}`;
    let heldInitialQueueReads = 0;
    let queueGateReleased = false;
    let releaseInitialQueue!: () => void;
    const initialQueueGate = new Promise<void>((resolve) => {
      releaseInitialQueue = () => {
        queueGateReleased = true;
        resolve();
      };
    });
    const releaseAfterJoining = (response: Response) => {
      const request = response.request();
      if (
        response.ok() &&
        request.method() === 'PUT' &&
        new URL(response.url()).pathname ===
          `/api/v1/rooms/${room.id}/watch-together/viewing` &&
        request.postDataJSON()?.present === true
      )
        releaseInitialQueue();
    };
    const holdInitialQueue = async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      let response: APIResponse | undefined;
      try {
        response = await route.fetch();
        if (!queueGateReleased) {
          heldInitialQueueReads++;
          await initialQueueGate;
        }
        await route.fulfill({ response });
      } catch (failure) {
        // StrictMode can cancel its first read while the real response is held.
        if (second.isClosed() || route.request().failure()) return;
        throw failure;
      } finally {
        await response?.dispose().catch(() => {});
      }
    };
    disposeInitialQueueGate = async () => {
      releaseInitialQueue();
      second.off('response', releaseAfterJoining);
      await second.unroute(queuePattern, holdInitialQueue).catch(() => {});
    };
    second.on('response', releaseAfterJoining);
    await second.route(queuePattern, holdInitialQueue);
    const viewer = await openWatch(second);
    const viewerQueue = viewer.getByRole('region', {
      name: 'YouTube watch queue',
      exact: true,
    });
    const viewerInput = viewerQueue.getByLabel('Add a YouTube video or Short', {
      exact: true,
    });
    await expect(viewerInput).toBeEnabled();
    await expect.poll(() => heldInitialQueueReads).toBeGreaterThan(0);
    expect(memberRequests.mutations).toEqual([]);
    await viewerInput.fill('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    await viewerQueue
      .getByLabel('Title (optional)', { exact: true })
      .fill('Friend queued Short');
    await viewerQueue
      .getByRole('button', { name: 'Add to queue', exact: true })
      .click();
    await expect
      .poll(async () => (await queue(member, room.id)).items.length)
      .toBe(1);
    expect((await queue(member, room.id)).items[0]).toMatchObject({
      author_id: memberUser.id,
      video: { id: 'dQw4w9WgXcQ', title: 'Friend queued Short' },
    });
    expect(
      memberRequests.mutations.filter(
        (request) => request.method === 'POST' && request.path === queuePath,
      ),
    ).toHaveLength(1);
    expect(await watch(member, room.id)).toMatchObject({
      playback_id: playback.playback_id,
      host_id: ownerUser.id,
      paused: true,
      youtube: { id: 'M7lc1UVf-VE' },
    });
    await expect
      .poll(async () => (await queue(member, room.id)).viewers)
      .toBe(2);
    await expect(
      viewerQueue.getByRole('button', { name: /Allow YouTube/ }),
    ).toBeVisible();
    await expect(second.locator('iframe')).toHaveCount(0);
    expect(memberRequests.providerRequests).toEqual([]);
    expect(
      memberRequests.mutations.some((request) =>
        request.path.endsWith('/next'),
      ),
    ).toBe(false);
    await expectNoVoice(member, room.id);
    await second.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect
      .poll(async () => (await queue(owner, room.id)).viewers)
      .toBe(1);
    await first.keyboard.press('Escape');
    await expect(host).toBeHidden();
    await expect
      .poll(async () => (await queue(owner, room.id)).viewers)
      .toBe(0);
  } finally {
    await disposeInitialQueueGate?.();
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await owner.close();
    await member.close();
  }
});

test('disabled YouTube explains the missing configuration and leaves shared video files available', async ({
  browser,
}, testInfo) => {
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const { community, room } = await setup(owner, member);
    communityId = community.id;
    const { message } = await value<{ message: { id: string } }>(
      await owner.request.post(`/api/v1/rooms/${room.id}/messages`, {
        headers,
        data: { body: videoURL },
      }),
    );
    const page = await owner.newPage();
    let configurationChecks = 0;
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      const json = await value<{ watch_together?: Record<string, unknown> }>(
        response,
      );
      configurationChecks += 1;
      await route.fulfill({
        response,
        json: {
          ...json,
          watch_together: { ...json.watch_together, youtube_enabled: false },
        },
      });
    });
    const requests = trackWatch(page, room.id);
    await enter(page, community);
    await page
      .locator(`[data-message-id="${message.id}"]`)
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Channel activities',
      exact: true,
    });
    const youtube = dialog.getByRole('region', {
      name: 'YouTube watch queue',
      exact: true,
    });
    await expect(youtube.getByRole('status')).toContainText(
      'YouTube watching is not enabled here yet.',
    );
    const input = youtube.getByLabel('Add a YouTube video or Short', {
      exact: true,
    });
    await expect(input).toHaveValue(canonicalURL);
    await expect(input).toHaveAttribute('readonly', '');
    await expect(
      dialog.getByRole('combobox', {
        name: 'Choose a video from this channel',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      youtube.getByRole('button', { name: 'Join Watch', exact: true }),
    ).toHaveCount(0);
    await expect(
      youtube.getByRole('button', { name: 'Watch together', exact: true }),
    ).toHaveCount(0);
    await expect(
      youtube.getByRole('button', { name: 'Add to queue', exact: true }),
    ).toHaveCount(0);
    const beforeRetry = configurationChecks;
    await youtube
      .getByRole('button', { name: 'Check again', exact: true })
      .click();
    await expect.poll(() => configurationChecks).toBeGreaterThan(beforeRetry);
    await expect(youtube.getByRole('status')).toContainText(
      'YouTube watching is not enabled here yet.',
    );
    expect(requests.mutations).toEqual([]);
    expect(requests.providerRequests).toEqual([]);
    expect(await watch(owner, room.id)).toBeNull();
    expect((await queue(owner, room.id)).viewers).toBe(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expectNoVoice(owner, room.id);
    await page.screenshot({
      path: testInfo.outputPath('watch-link-disabled-configuration.png'),
    });
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await owner.close();
    await member.close();
  }
});

test('retrying a queued video after a failed start creates one playback without duplicating the queue', async ({
  browser,
}) => {
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const { community, ownerUser, room } = await setup(owner, member);
    communityId = community.id;
    const page = await owner.newPage();
    let nextRequests = 0;
    const queueNonces: string[] = [];
    const nextStatuses: number[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          `/api/v1/rooms/${room.id}/watch-together/queue`
      )
        queueNonces.push(request.postDataJSON().client_nonce);
    });
    page.on('response', (response) => {
      if (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/v1/rooms/${room.id}/watch-together/next`
      )
        nextStatuses.push(response.status());
    });
    await page.route(
      `**/api/v1/rooms/${room.id}/watch-together/next`,
      async (route) => {
        if (route.request().method() === 'POST' && ++nextRequests === 1) {
          await route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'conflict',
                message: 'Refresh playback before trying again.',
              },
            },
          });
        } else await route.continue();
      },
    );
    const requests = trackWatch(page, room.id);
    await enter(page, community);
    const dialog = await openWatch(page);
    const youtube = dialog.getByRole('region', {
      name: 'YouTube watch queue',
      exact: true,
    });
    const input = youtube.getByLabel('Add a YouTube video or Short', {
      exact: true,
    });
    const title = youtube.getByLabel('Title (optional)', { exact: true });
    await expect(input).toBeEnabled();
    await input.fill(videoURL);
    await title.fill('Retry this exact video');
    await youtube
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    await expect(youtube.getByRole('alert')).toContainText(
      'Your video is already in the queue, but playback could not start.',
    );
    await expect(input).toHaveValue(videoURL);
    await expect(title).toHaveValue('Retry this exact video');
    const afterFailure = await queue(owner, room.id);
    expect(afterFailure.items).toHaveLength(1);
    expect(afterFailure.items[0]).toMatchObject({
      video: { id: 'M7lc1UVf-VE' },
    });
    expect(await watch(owner, room.id)).toBeNull();
    expect(nextStatuses).toEqual([409]);
    await expect(
      youtube.getByRole('button', { name: 'Start queue', exact: true }),
    ).toBeEnabled();

    await youtube
      .getByRole('button', { name: 'Watch together', exact: true })
      .click();
    await expect
      .poll(async () => (await watch(owner, room.id))?.youtube.id)
      .toBe('M7lc1UVf-VE');
    expect(await watch(owner, room.id)).toMatchObject({
      source_kind: 'youtube',
      host_id: ownerUser.id,
      paused: true,
    });
    expect((await queue(owner, room.id)).items).toEqual([]);
    expect(queueNonces).toHaveLength(2);
    expect(queueNonces[0]).toBeTruthy();
    expect(queueNonces[1]).toBe(queueNonces[0]);
    expect(nextRequests).toBe(2);
    await expect.poll(() => nextStatuses).toEqual([409, 200]);
    await expect(input).toHaveValue('');
    await expect(title).toHaveValue('');
    await expect(
      youtube.getByRole('button', { name: /Allow YouTube/ }),
    ).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(requests.providerRequests).toEqual([]);
    await expectNoVoice(owner, room.id);
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await owner.close();
    await member.close();
  }
});
