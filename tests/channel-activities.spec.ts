import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
};
type Community = {
  id: string;
  name: string;
  channels: { id: string; name: string }[];
};
type Snapshot = {
  polls: {
    id: string;
    question: string;
    counts: number[];
    vote: number | null;
    closed_at: string | null;
  }[];
  events: { id: string; title: string }[];
  assets: { id: string; name: string; kind: string; attachment: Attachment }[];
  watch: {
    revision: number;
    paused: boolean;
    position_seconds: number;
    host_id: string;
  } | null;
};
async function value<T>(response: APIResponse): Promise<T> {
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
async function setup(
  owner: BrowserContext,
  member: BrowserContext,
  suffix: string,
) {
  const ownerUser = await login(owner, 'Activities Owner', suffix);
  const memberUser = await login(member, 'Activities Member', suffix);
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
      data: { name: `Activity friends ${suffix}` },
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
async function enter(page: Page, community: Community) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await page
    .getByRole('list', { name: `${community.name} channel list`, exact: true })
    .getByRole('button', { name: 'general', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Message general', exact: true }),
  ).toBeVisible();
}
async function activities(page: Page, tab: string, community: Community) {
  const call = page.getByRole('main', { name: 'Call', exact: true });
  const callConversation = call.getByRole('region', {
    name: `${community.name} · general`,
    exact: true,
  });
  const conversation = (await callConversation.isVisible())
    ? callConversation
    : page.getByRole('region', {
        name: `${community.name} · general`,
        exact: true,
      });
  await expect(conversation).toBeVisible();
  await conversation
    .getByRole('button', { name: 'Channel activities', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Channel activities',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('group', { name: 'Activity views' })
    .getByRole('button', { name: tab, exact: true })
    .click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Loading activities' }),
  ).toHaveCount(0);
  return dialog;
}
async function snapshot(context: BrowserContext, room: string) {
  return value<Snapshot>(
    await context.request.get(`/api/v1/rooms/${room}/activities`),
  );
}

test('friends vote, schedule and dismiss durable reminders, and inspect edited message versions', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  const outsider = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { community, room } = await setup(owner, member, suffix);
    communityId = community.id;
    await login(outsider, 'Activities Outsider', suffix);
    const ownerPage = await owner.newPage();
    const memberPage = await member.newPage();
    await enter(ownerPage, community);
    await enter(memberPage, community);
    const ownerDialog = await activities(ownerPage, 'Polls', community);
    const memberDialog = await activities(memberPage, 'Polls', community);
    await ownerDialog
      .getByRole('button', { name: 'New poll', exact: true })
      .click();
    await ownerDialog
      .getByRole('textbox', { name: 'Question', exact: true })
      .fill('What are we doing tonight?');
    await ownerDialog
      .getByRole('textbox', { name: 'Poll option 1', exact: true })
      .fill('Game night');
    await ownerDialog
      .getByRole('textbox', { name: 'Poll option 2', exact: true })
      .fill('Movie night');
    await ownerDialog
      .getByRole('button', { name: 'Create poll', exact: true })
      .click();
    const ownerPoll = ownerDialog.getByRole('article').filter({
      has: ownerPage.getByRole('heading', {
        name: 'What are we doing tonight?',
        exact: true,
      }),
    });
    const memberPoll = memberDialog.getByRole('article').filter({
      has: memberPage.getByRole('heading', {
        name: 'What are we doing tonight?',
        exact: true,
      }),
    });
    await expect(memberPoll).toBeVisible();
    await memberPoll.getByRole('button', { name: /Movie night/ }).click();
    await expect(ownerPoll).toContainText('1 vote');
    await memberPoll.getByRole('button', { name: /Game night/ }).click();
    await expect
      .poll(async () => (await snapshot(member, room.id)).polls[0].vote)
      .toBe(0);
    await expect(ownerPoll).toContainText('1 vote');
    await ownerPoll
      .getByRole('button', { name: 'End poll', exact: true })
      .click();
    await expect(memberPoll).toContainText('Closed');
    await expect(
      memberPoll.getByRole('button', { name: /Game night/ }),
    ).toBeDisabled();
    const poll = (await snapshot(owner, room.id)).polls[0];
    expect(
      (
        await member.request.put(
          `/api/v1/rooms/${room.id}/polls/${poll.id}/vote`,
          { headers, data: { option: 1 } },
        )
      ).status(),
    ).toBe(409);
    const inaccessibleActivities = await outsider.request.get(
      `/api/v1/rooms/${room.id}/activities`,
    );
    expect(inaccessibleActivities.status()).toBe(404);
    expect(await inaccessibleActivities.json()).toEqual({
      error: { code: 'not_found', message: 'resource not found' },
    });

    await ownerDialog
      .getByRole('button', { name: 'Events', exact: true })
      .click();
    await ownerDialog
      .getByRole('button', { name: 'Schedule event', exact: true })
      .click();
    await ownerDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Friends arrive soon');
    await ownerDialog
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Ready for the next match.');
    const localTime = await ownerPage.evaluate(() => {
      const date = new Date(Date.now() + 4 * 60000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    });
    await ownerDialog
      .getByLabel('Date and time', { exact: true })
      .fill(localTime);
    await ownerDialog
      .getByRole('button', { name: 'Schedule', exact: true })
      .click();
    await memberDialog
      .getByRole('button', { name: 'Events', exact: true })
      .click();
    const event = memberDialog.getByRole('article').filter({
      has: memberPage.getByRole('heading', {
        name: 'Friends arrive soon',
        exact: true,
      }),
    });
    await expect(event).toBeVisible();
    const maybe = event.getByRole('button', { name: 'Maybe', exact: true });
    await maybe.click();
    await expect(maybe).toHaveAttribute('aria-pressed', 'true');
    await memberPage.keyboard.press('Escape');
    await expect(memberDialog).toBeHidden();
    await memberPage.getByRole('button', { name: /^Event reminders/ }).click();
    const reminders = memberPage.getByRole('dialog', {
      name: 'Event reminders',
      exact: true,
    });
    await expect(reminders).toContainText('Friends arrive soon');
    const first = await value<{ reminders: { id: string }[] }>(
      await member.request.get('/api/v1/me/event-reminders'),
    );
    const again = await value<{ reminders: { id: string }[] }>(
      await member.request.get('/api/v1/me/event-reminders'),
    );
    expect(again.reminders[0].id).toBe(first.reminders[0].id);
    await reminders
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
    await expect(reminders).toContainText('No events due yet.');
    await memberPage.keyboard.press('Escape');
    await memberPage.reload();
    await memberPage.getByRole('button', { name: /^Event reminders/ }).click();
    const restoredReminders = await value<{ reminders: unknown[] }>(
      await member.request.get('/api/v1/me/event-reminders'),
    );
    expect(restoredReminders.reminders).toHaveLength(0);
    await expect(
      memberPage.getByRole('dialog', { name: 'Event reminders', exact: true }),
    ).toContainText('No events due yet.');
    await memberPage.keyboard.press('Escape');

    const { message } = await value<{ message: { id: string } }>(
      await owner.request.post(`/api/v1/rooms/${room.id}/messages`, {
        headers,
        data: { body: 'Original meetup text' },
      }),
    );
    await value(
      await owner.request.patch(
        `/api/v1/rooms/${room.id}/messages/${message.id}`,
        { headers, data: { body: 'Revised meetup text' } },
      ),
    );
    await expect(
      memberPage.getByRole('log', { name: 'Messages', exact: true }),
    ).toContainText('Revised meetup text');
    await memberPage
      .locator(`[data-message-id="${message.id}"]`)
      .getByRole('button', { name: 'View edit history', exact: true })
      .click();
    const history = memberPage.getByRole('dialog', {
      name: 'Edit history',
      exact: true,
    });
    await expect(history).toContainText('Original meetup text');
    await expect(history).toContainText('Revised meetup text');
    const inaccessibleHistory = await outsider.request.get(
      `/api/v1/rooms/${room.id}/messages/${message.id}/history`,
    );
    expect(inaccessibleHistory.status()).toBe(404);
    expect(await inaccessibleHistory.json()).toEqual({
      error: { code: 'not_found', message: 'resource not found' },
    });
    await memberPage.keyboard.press('Escape');
    await value(
      await owner.request.delete(
        `/api/v1/rooms/${room.id}/messages/${message.id}`,
        { headers },
      ),
    );
    expect(
      (
        await member.request.get(
          `/api/v1/rooms/${room.id}/messages/${message.id}/history`,
        )
      ).status(),
    ).toBe(404);
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await Promise.allSettled([owner.close(), member.close(), outsider.close()]);
  }
});

function wavFixture(seconds = 6) {
  const rate = 16000;
  const count = rate * seconds;
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index / rate) * 440 * Math.PI * 2) * 5000),
      44 + index * 2,
    );
  return bytes;
}

test('private stickers send reusable images and voice soundboard has independent volume, mute and deafen cleanup', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const { community, room } = await setup(
      owner,
      member,
      `${Date.now()}-media`,
    );
    communityId = community.id;
    await member.addInitScript(() => {
      const outputs: HTMLAudioElement[] = [];
      Object.defineProperty(window, '__activitySoundOutputs', {
        value: outputs,
      });
      const NativeAudio = window.Audio;
      window.Audio = class extends NativeAudio {
        constructor(src?: string) {
          super(src);
          outputs.push(this);
        }
      };
    });
    const ownerPage = await owner.newPage();
    const memberPage = await member.newPage();
    await enter(ownerPage, community);
    await enter(memberPage, community);
    const image = Buffer.from(
      await ownerPage.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 24;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#4466bb';
        context.fillRect(0, 0, 32, 24);
        return canvas.toDataURL('image/png').split(',')[1];
      }),
      'base64',
    );
    const ownerDialog = await activities(ownerPage, 'Stickers', community);
    await ownerDialog
      .getByRole('button', { name: 'Add sticker', exact: true })
      .click();
    await ownerDialog
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Victory sticker');
    await ownerDialog.locator('input[type=file]').setInputFiles({
      name: 'victory.png',
      mimeType: 'image/png',
      buffer: image,
    });
    await ownerDialog
      .getByRole('button', { name: 'Add to channel', exact: true })
      .click();
    await expect(
      ownerDialog.getByRole('img', { name: 'Victory sticker', exact: true }),
    ).toBeVisible();
    const memberDialog = await activities(memberPage, 'Stickers', community);
    await expect(
      memberDialog.getByRole('img', { name: 'Victory sticker', exact: true }),
    ).toBeVisible();
    await memberDialog
      .getByRole('button', { name: 'Send', exact: true })
      .click();
    await memberPage.keyboard.press('Escape');
    await expect(
      memberPage.getByRole('log', { name: 'Messages', exact: true }),
    ).toContainText('Sticker: Victory sticker');
    await expect
      .poll(async () => {
        const { messages } = await value<{
          messages: { attachments: Attachment[] }[];
        }>(await member.request.get(`/api/v1/rooms/${room.id}/messages`));
        return messages[0].attachments[0].id;
      })
      .toBe((await snapshot(owner, room.id)).assets[0].attachment.id);
    await ownerDialog
      .getByRole('button', { name: 'Soundboard', exact: true })
      .click();
    await ownerDialog
      .getByRole('button', { name: 'Add sound', exact: true })
      .click();
    await ownerDialog
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Victory sound');
    await ownerDialog.locator('input[type=file]').setInputFiles({
      name: 'victory.wav',
      mimeType: 'audio/wav',
      buffer: wavFixture(),
    });
    await ownerDialog
      .getByRole('button', { name: 'Add to channel', exact: true })
      .click();
    await expect(
      ownerDialog.getByText('Victory sound', { exact: true }),
    ).toBeVisible();
    const sound = (await snapshot(owner, room.id)).assets.find(
      (asset) => asset.kind === 'sound',
    )!;
    expect(
      (
        await owner.request.post(
          `/api/v1/rooms/${room.id}/media-assets/${sound.id}/play`,
          { headers, data: {} },
        )
      ).status(),
    ).toBe(403);
    await ownerPage.keyboard.press('Escape');
    for (const page of [ownerPage, memberPage]) {
      await page
        .getByRole('region', {
          name: `${community.name} · general`,
          exact: true,
        })
        .getByRole('button', { name: 'Join voice', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Leave call', exact: true }),
      ).toBeVisible();
    }
    const memberSounds = await activities(memberPage, 'Soundboard', community);
    await memberSounds
      .getByRole('button', { name: 'Enable audio', exact: true })
      .click();
    const volume = memberSounds.getByRole('slider', {
      name: 'Soundboard volume',
      exact: true,
    });
    await volume.focus();
    await volume.press('Home');
    for (let step = 0; step < 5; step++) await volume.press('ArrowRight');
    const ownerSounds = await activities(ownerPage, 'Soundboard', community);
    await ownerSounds
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(() =>
        memberPage.evaluate(() => {
          const elements = (
            window as unknown as { __activitySoundOutputs: HTMLAudioElement[] }
          ).__activitySoundOutputs;
          const audio = elements.find(
            (element) =>
              element.src.includes('victory.wav') ||
              element.src.includes('messages/'),
          );
          return (
            audio &&
            !audio.paused &&
            audio.currentTime > 0 &&
            audio.volume === 0.25
          );
        }),
      )
      .toBe(true);
    await memberSounds
      .getByRole('checkbox', { name: 'Mute soundboard', exact: true })
      .check();
    await expect
      .poll(() =>
        memberPage.evaluate(() =>
          (
            window as unknown as { __activitySoundOutputs: HTMLAudioElement[] }
          ).__activitySoundOutputs
            .filter((audio) => audio.getAttribute('src'))
            .every((audio) => audio.muted),
        ),
      )
      .toBe(true);
    await memberSounds
      .getByRole('checkbox', { name: 'Mute soundboard', exact: true })
      .uncheck();
    await memberPage.keyboard.press('Escape');
    await memberPage
      .getByRole('button', { name: 'Deafen call', exact: true })
      .click();
    await expect
      .poll(() =>
        memberPage.evaluate(() =>
          (
            window as unknown as { __activitySoundOutputs: HTMLAudioElement[] }
          ).__activitySoundOutputs.every(
            (audio) => !audio.getAttribute('src') && audio.paused,
          ),
        ),
      )
      .toBe(true);
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await Promise.allSettled([owner.close(), member.close()]);
  }
});

test('two viewers start manually, follow authoritative video commands, transfer host and restore session after reload', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const { community, room, memberUser } = await setup(
      owner,
      member,
      `${Date.now()}-watch`,
    );
    communityId = community.id;
    const fixture = readFileSync(
      path.join(__dirname, 'fixtures', 'attachment-preview.mp4'),
    );
    const { attachment } = await value<{ attachment: Attachment }>(
      await owner.request.post(`/api/v1/rooms/${room.id}/attachments`, {
        headers,
        multipart: {
          file: {
            name: 'watch-together.mp4',
            mimeType: 'video/mp4',
            buffer: fixture,
          },
        },
      }),
    );
    await value(
      await owner.request.post(`/api/v1/rooms/${room.id}/messages`, {
        headers,
        data: { body: 'Shared video', attachment_ids: [attachment.id] },
      }),
    );
    const ownerPage = await owner.newPage();
    const memberPage = await member.newPage();
    await enter(ownerPage, community);
    await enter(memberPage, community);
    const ownerDialog = await activities(
      ownerPage,
      'Watch together',
      community,
    );
    await ownerDialog
      .getByRole('combobox', {
        name: 'Choose a video from this channel',
        exact: true,
      })
      .selectOption(attachment.id);
    await ownerDialog
      .getByRole('button', { name: 'Watch together', exact: true })
      .last()
      .click();
    const memberDialog = await activities(
      memberPage,
      'Watch together',
      community,
    );
    const ownerVideo = ownerDialog.locator('video');
    const memberVideo = memberDialog.locator('video');
    await expect
      .poll(() =>
        memberVideo.evaluate(
          (element) => (element as HTMLVideoElement).readyState,
        ),
      )
      .toBeGreaterThan(0);
    expect(
      await memberVideo.evaluate(
        (element) => (element as HTMLVideoElement).paused,
      ),
    ).toBe(true);
    await memberDialog
      .getByRole('button', { name: 'Start playback', exact: true })
      .click();
    await expect(
      ownerDialog.getByRole('button', {
        name: 'Play for everyone',
        exact: true,
      }),
    ).toBeEnabled();
    await ownerDialog
      .getByRole('button', { name: 'Play for everyone', exact: true })
      .click();
    await expect
      .poll(() =>
        memberVideo.evaluate(
          (element) => (element as HTMLVideoElement).currentTime,
        ),
      )
      .toBeGreaterThan(0);
    await ownerDialog
      .getByRole('button', { name: 'Pause for everyone', exact: true })
      .click();
    await expect
      .poll(() =>
        memberVideo.evaluate((element) => (element as HTMLVideoElement).paused),
      )
      .toBe(true);
    const paused = (await snapshot(owner, room.id)).watch!;
    expect(
      (
        await member.request.put(`/api/v1/rooms/${room.id}/watch-together`, {
          headers,
          data: {
            action: 'seek',
            position_seconds: 0,
            revision: paused.revision,
          },
        })
      ).status(),
    ).toBe(403);
    const seek = await value<{ watch: Snapshot['watch'] }>(
      await owner.request.put(`/api/v1/rooms/${room.id}/watch-together`, {
        headers,
        data: {
          action: 'seek',
          position_seconds: 0.3,
          revision: paused.revision,
        },
      }),
    );
    await expect
      .poll(() =>
        memberVideo.evaluate(
          (element) => (element as HTMLVideoElement).currentTime,
        ),
      )
      .toBeCloseTo(0.3, 1);
    expect(
      (
        await owner.request.put(`/api/v1/rooms/${room.id}/watch-together`, {
          headers,
          data: {
            action: 'seek',
            position_seconds: 0,
            revision: paused.revision,
          },
        })
      ).status(),
    ).toBe(409);
    await ownerDialog
      .getByRole('combobox', { name: 'Hand playback to', exact: true })
      .selectOption(memberUser.id);
    await ownerDialog
      .getByRole('button', { name: 'Transfer control', exact: true })
      .click();
    await expect(memberDialog).toContainText('You control playback');
    expect((await snapshot(member, room.id)).watch?.revision).toBeGreaterThan(
      seek.watch!.revision,
    );
    await memberPage.reload();
    const restored = await activities(memberPage, 'Watch together', community);
    await expect(restored).toContainText('You control playback');
    await expect(
      restored.getByRole('button', { name: 'Start playback', exact: true }),
    ).toBeVisible();
    expect((await snapshot(member, room.id)).watch?.host_id).toBe(
      memberUser.id,
    );
    await restored
      .getByRole('button', { name: 'End session', exact: true })
      .click();
    await expect(ownerDialog.locator('video')).toHaveCount(0);
    await expect
      .poll(async () => (await snapshot(member, room.id)).watch)
      .toBeNull();
    expect(await ownerVideo.count()).toBe(0);
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await Promise.allSettled([owner.close(), member.close()]);
  }
});
