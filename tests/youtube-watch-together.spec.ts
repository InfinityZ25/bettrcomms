import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';

test.skip(
  process.env.E2E_YOUTUBE_REAL !== '1',
  'Run explicitly with the real provider and an HTTPS isolated player.',
);
test.use({ actionTimeout: 20000 });
const baseURL = process.env.E2E_BASE_URL ?? 'https://localhost:5175';
const localCertificate =
  process.env.E2E_LOCAL_HTTPS_CERT === '1' &&
  ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname);
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Community = {
  id: string;
  name: string;
  channels: { id: string; name: string }[];
};
type State = {
  playback_id: string;
  source_kind: string;
  host_id: string;
  paused: boolean;
  revision: number;
  position_seconds: number;
  youtube: { id: string; title: string };
};
async function value<T>(response: APIResponse) {
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
          email: `${name.replaceAll(' ', '-')}-${suffix}@example.test`,
        },
      }),
    )
  ).user;
}
async function enter(page: Page, community: Community) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await page
    .getByRole('list', { name: `${community.name} channel list`, exact: true })
    .getByRole('button', { name: community.channels[0].name, exact: true })
    .click();
  await expect(
    page.getByRole('textbox', {
      name: `Message ${community.channels[0].name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Channel activities', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Channel activities',
    exact: true,
  });
  await dialog
    .getByRole('group', { name: 'Activity views' })
    .getByRole('button', { name: 'Watch together', exact: true })
    .click();
  return dialog;
}
async function state(context: BrowserContext, room: string) {
  return (
    await value<{ watch: State | null }>(
      await context.request.get(
        `/api/v1/rooms/${room}/activities?watch_sources=file,youtube`,
      ),
    )
  ).watch;
}

test('real HTTPS YouTube player synchronizes two viewers, transfers host and isolates credentials', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180000);
  const owner = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: localCertificate,
  });
  const member = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: localCertificate,
  });
  let communityID = '';
  try {
    const suffix = `${Date.now()}`;
    const firstUser = await login(owner, 'YouTube Host', suffix);
    const secondUser = await login(member, 'YouTube Viewer', suffix);
    const { request } = await value<{ request: { id: string } }>(
      await owner.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: secondUser.id },
      }),
    );
    await value(
      await member.request.post(
        `/api/v1/friends/requests/${request.id}/accept`,
        { headers, data: {} },
      ),
    );
    const { community } = await value<{ community: Community }>(
      await owner.request.post('/api/v1/communities', {
        headers,
        data: { name: `YouTube HTTPS ${suffix}` },
      }),
    );
    communityID = community.id;
    await value(
      await owner.request.post(`/api/v1/communities/${community.id}/members`, {
        headers,
        data: { user_id: secondUser.id },
      }),
    );
    const room = community.channels[0].id;
    const first = await owner.newPage();
    const second = await member.newPage();
    const requests: string[] = [];
    const watchWrites: { action: string; status: number }[] = [];
    first.on('response', (response) => {
      const request = response.request();
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname.endsWith('/watch-together')
      )
        watchWrites.push({
          action: request.postDataJSON().action,
          status: response.status(),
        });
    });
    first.on('request', (request) => {
      if (
        request.url().includes('youtube.com') ||
        request.url().includes('ytimg.com')
      )
        requests.push(request.url());
    });
    const host = await enter(first, community);
    const viewer = await enter(second, community);
    await host.getByRole('button', { name: 'Join Watch', exact: true }).click();
    await viewer
      .getByRole('button', { name: 'Join Watch', exact: true })
      .click();
    await host
      .getByLabel('Add a YouTube video or Short', { exact: true })
      .fill('https://youtu.be/M7lc1UVf-VE');
    await host
      .getByLabel('Title (optional)', { exact: true })
      .fill('YouTube IFrame API demo');
    await host
      .getByRole('button', { name: 'Add to queue', exact: true })
      .click();
    await expect(
      host.getByRole('button', { name: 'Start queue', exact: true }),
    ).toBeEnabled();
    await host
      .getByRole('button', { name: 'Start queue', exact: true })
      .click();
    await expect
      .poll(async () => (await state(owner, room))?.source_kind)
      .toBe('youtube');
    expect((await state(owner, room))?.host_id).toBe(firstUser.id);
    expect(requests).toEqual([]);
    expect(await first.locator('iframe').count()).toBe(0);
    await host.getByRole('button', { name: /Allow YouTube/ }).click();
    await viewer.getByRole('button', { name: /Allow YouTube/ }).click();
    await expect
      .poll(() =>
        Boolean(
          first.frames().find((frame) => frame.url().includes('/player')),
        ),
      )
      .toBe(true);
    await expect(
      host.getByRole('button', { name: 'Play for everyone', exact: true }),
    ).toBeEnabled({ timeout: 45000 });
    await expect(
      viewer.getByRole('button', { name: 'Pause on this device', exact: true }),
    ).toBeEnabled({ timeout: 45000 });
    const helper = first
      .frames()
      .find((frame) => frame.url().includes('/player'))!;
    const viewerHelper = second
      .frames()
      .find((frame) => frame.url().includes('/player'))!;
    expect(helper.url()).not.toMatch(/ticket|token|session/);
    const isolation = await helper.evaluate(async () => {
      const main = ['__BETTERCOMMS_DESKTOP__', '_wails', '__wails', 'wails'];
      const status = await fetch('/api/v1/me', { credentials: 'omit' });
      return {
        denied: status.status,
        cookie: document.cookie,
        native: main.some((key) => key in window),
        sdk: Boolean((window as unknown as { YT?: unknown }).YT),
      };
    });
    expect(isolation).toEqual({
      denied: 404,
      cookie: '',
      native: false,
      sdk: true,
    });
    expect(await first.evaluate(() => 'YT' in window)).toBe(false);
    expect(watchWrites.filter((write) => write.action !== 'heartbeat')).toEqual(
      [],
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const revisionBeforePlay = (await state(owner, room))!.revision;
      await host
        .getByRole('button', { name: 'Play for everyone', exact: true })
        .click();
      await expect
        .poll(async () => (await state(owner, room))?.paused)
        .toBe(false);
      await expect
        .poll(async () => helper.evaluate('player?.getPlayerState()'))
        .toBe(1);
      await expect
        .poll(async () => viewerHelper.evaluate('player?.getPlayerState()'))
        .toBe(1);
      await host
        .getByRole('button', { name: 'Pause for everyone', exact: true })
        .click();
      await expect
        .poll(async () => (await state(owner, room))?.paused)
        .toBe(true);
      await expect
        .poll(async () => helper.evaluate('player?.getPlayerState()'))
        .toBe(2);
      await expect
        .poll(async () => viewerHelper.evaluate('player?.getPlayerState()'))
        .toBe(2);
      const paused = (await state(owner, room))!;
      expect(paused.revision).toBe(revisionBeforePlay + 2);
      expect(
        watchWrites.filter((write) => write.action !== 'heartbeat'),
      ).toEqual(
        Array.from({ length: cycle + 1 }).flatMap(() => [
          { action: 'play', status: 200 },
          { action: 'pause', status: 200 },
        ]),
      );
    }
    const sharedPosition = host.getByRole('slider', {
      name: 'YouTube shared position',
      exact: true,
    });
    await expect(sharedPosition).toBeEnabled();
    await sharedPosition.focus();
    for (let step = 0; step < 3; step += 1)
      await first.keyboard.down('ArrowRight');
    const seekTo = Number(await sharedPosition.inputValue());
    await first.keyboard.up('ArrowRight');
    await expect
      .poll(async () => (await state(owner, room))?.position_seconds)
      .toBe(seekTo);
    await expect
      .poll(async () =>
        Math.abs(
          (await helper.evaluate<number>('player?.getCurrentTime()')) - seekTo,
        ),
      )
      .toBeLessThan(1.5);
    await expect
      .poll(async () =>
        Math.abs(
          (await viewerHelper.evaluate<number>('player?.getCurrentTime()')) -
            seekTo,
        ),
      )
      .toBeLessThan(1.5);
    await expect(sharedPosition).toBeEnabled();
    await first.keyboard.press('Tab');
    await expect(
      host.getByRole('button', { name: 'End session', exact: true }),
    ).toBeFocused();
    await first.bringToFront();
    const officialFrame = helper
      .childFrames()
      .find((frame) =>
        frame.url().startsWith('https://www.youtube-nocookie.com/embed/'),
      )!;
    await host.locator('iframe').scrollIntoViewIfNeeded();
    await officialFrame.locator('#player-controls').hover();
    await officialFrame
      .getByRole('button', { name: 'Play video', exact: true })
      .press('Space');
    await expect
      .poll(async () => (await state(owner, room))?.paused)
      .toBe(false);
    await expect
      .poll(() => viewerHelper.evaluate('player?.getPlayerState()'))
      .toBe(1);
    await expect(
      host.getByRole('button', { name: 'Pause for everyone', exact: true }),
    ).toBeEnabled();
    await host.locator('iframe').scrollIntoViewIfNeeded();
    await officialFrame.locator('#player-controls').hover();
    await officialFrame
      .getByRole('button', { name: 'Pause video', exact: true })
      .press('Space');
    await expect
      .poll(async () => (await state(owner, room))?.paused)
      .toBe(true);
    await expect
      .poll(() => viewerHelper.evaluate('player?.getPlayerState()'))
      .toBe(2);
    expect(watchWrites.filter((write) => write.action !== 'heartbeat')).toEqual(
      [
        ...Array.from({ length: 3 }).flatMap(() => [
          { action: 'play', status: 200 },
          { action: 'pause', status: 200 },
        ]),
        { action: 'seek', status: 200 },
        { action: 'play', status: 200 },
        { action: 'pause', status: 200 },
      ],
    );
    await host
      .getByLabel('YouTube next host', { exact: true })
      .selectOption(secondUser.id);
    await host
      .getByRole('button', { name: 'Transfer control', exact: true })
      .click();
    await expect
      .poll(async () => (await state(owner, room))?.host_id)
      .toBe(secondUser.id);
    await expect(
      viewer.getByRole('button', { name: 'Play for everyone', exact: true }),
    ).toBeEnabled();
    await expect(
      host.getByRole('button', { name: 'Play for everyone', exact: true }),
    ).toHaveCount(0);
    expect(watchWrites.filter((write) => write.action === 'seek')).toEqual([
      { action: 'seek', status: 200 },
    ]);
    await second.setViewportSize({ width: 375, height: 812 });
    const rectangle = await viewer.locator('iframe').boundingBox();
    expect(rectangle?.height).toBeGreaterThanOrEqual(200);
    expect(rectangle?.width).toBeGreaterThanOrEqual(200);
    expect(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await viewer.screenshot({
      path: testInfo.outputPath('youtube-mobile-real.png'),
    });
    await first.keyboard.press('Escape');
    await expect(first.locator('iframe')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await value<{ viewers: number }>(
              await owner.request.get(
                `/api/v1/rooms/${room}/watch-together/queue`,
              ),
            )
          ).viewers,
      )
      .toBe(1);
  } finally {
    if (communityID)
      await owner.request.delete(`/api/v1/communities/${communityID}`, {
        headers,
      });
    await owner.close();
    await member.close();
  }
});
