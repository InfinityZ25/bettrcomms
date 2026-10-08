import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  coloredPDFFixture,
  installSyntheticCapture,
  revealCallControls,
  type SyntheticCaptureWindow,
} from './fixtures/communityExperience';

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
async function createCommunity(context: BrowserContext, suffix: string) {
  return (
    await value<{ community: Community }>(
      await context.request.post('/api/v1/communities', {
        headers,
        data: { name: `Production friends ${suffix}` },
      }),
    )
  ).community;
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
async function publishedFile(
  context: BrowserContext,
  room: string,
  name: string,
  contentType: string,
  buffer: Buffer,
) {
  const { attachment } = await value<{ attachment: Attachment }>(
    await context.request.post(`/api/v1/rooms/${room}/attachments`, {
      headers,
      multipart: { file: { name, mimeType: contentType, buffer } },
    }),
  );
  await value(
    await context.request.post(`/api/v1/rooms/${room}/messages`, {
      headers,
      data: { body: name, attachment_ids: [attachment.id] },
    }),
  );
  return attachment;
}

async function requireClipCapture(
  context: BrowserContext,
  browserName: string,
) {
  const probe = await context.newPage();
  let missing: string[];
  try {
    await probe.goto('/');
    missing = await probe.evaluate(() => {
      const capabilities = {
        MediaStream: typeof MediaStream === 'function',
        MediaStreamTrack: typeof MediaStreamTrack === 'function',
        MediaRecorder: typeof MediaRecorder === 'function',
        AudioContext: typeof AudioContext === 'function',
        canvasCapture:
          typeof HTMLCanvasElement.prototype.captureStream === 'function',
      };
      return Object.entries(capabilities)
        .filter(([, available]) => !available)
        .map(([name]) => name);
    });
  } finally {
    await probe.close();
  }
  // Some Playwright WebKit ports omit the recorder/stream bindings at build time.
  // Report that gate explicitly; never replace real codecs with a fixture mock.
  test.skip(
    browserName === 'webkit' && missing.length > 0,
    `This WebKit build omits clip capture APIs: ${missing.join(', ')}`,
  );
  expect(
    missing,
    'Chromium must provide real clip capture and encoding',
  ).toEqual([]);
}

test('optimized file library renders private PDF pages and applies type, author and local-date filters', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  const outsider = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const suffix = `${Date.now()}-pdf-${Math.random().toString(36).slice(2)}`;
    const ownerUser = await login(owner, 'PDF Owner', suffix);
    const memberUser = await login(member, 'PDF Member', suffix);
    await login(outsider, 'PDF Outsider', suffix);
    const { request } = await value<{ request: { id: string } }>(
      await owner.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: memberUser.id },
      }),
    );
    await value(
      await member.request.post(
        `/api/v1/friends/requests/${request.id}/accept`,
        { headers, data: {} },
      ),
    );
    const community = await createCommunity(owner, suffix);
    communityId = community.id;
    await value(
      await owner.request.post(`/api/v1/communities/${communityId}/members`, {
        headers,
        data: { user_id: memberUser.id },
      }),
    );
    const room = community.channels[0]!;
    const pdf = coloredPDFFixture();
    const ownerPDF = await publishedFile(
      owner,
      room.id,
      'owner-report.pdf',
      'application/pdf',
      pdf,
    );
    await publishedFile(
      member,
      room.id,
      'member-report.pdf',
      'application/pdf',
      pdf,
    );
    await publishedFile(
      member,
      room.id,
      'meeting-notes.txt',
      'text/plain',
      Buffer.from('Planning the next game night.\n'),
    );
    const page = await owner.newPage();
    await enter(page, community);
    await page
      .getByRole('button', { name: 'Channel file library', exact: true })
      .click();
    const library = page.getByRole('dialog', {
      name: 'Channel files',
      exact: true,
    });
    const files = library.getByRole('list', {
      name: 'Channel files',
      exact: true,
    });
    await expect(files.getByRole('listitem')).toHaveCount(3);
    await library
      .getByRole('combobox', { name: 'File type', exact: true })
      .selectOption('pdf');
    await library
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    await expect(files.getByRole('listitem')).toHaveCount(2);
    await library
      .getByRole('combobox', { name: 'File author', exact: true })
      .selectOption(ownerUser.id);
    const dates = await page.evaluate(() => {
      const format = (date: Date) =>
        new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 10);
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      return { today: format(today), tomorrow: format(tomorrow) };
    });
    await library
      .getByLabel('Files from date', { exact: true })
      .fill(dates.today);
    await library
      .getByLabel('Files through date', { exact: true })
      .fill(dates.today);
    await library
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    await expect(files.getByRole('listitem')).toHaveCount(1);
    await expect(files).toContainText('owner-report.pdf');
    await expect(files).not.toContainText('member-report.pdf');
    await library
      .getByLabel('Files from date', { exact: true })
      .fill(dates.tomorrow);
    await library
      .getByLabel('Files through date', { exact: true })
      .fill(dates.tomorrow);
    await library
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    await expect(library).toContainText('No files match these filters.');
    await library
      .getByLabel('Files from date', { exact: true })
      .fill(dates.today);
    await library
      .getByLabel('Files through date', { exact: true })
      .fill(dates.today);
    await library
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    await expect(files.getByRole('listitem')).toHaveCount(1);
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname ===
        `/api/v1/rooms/${room.id}/files/${ownerPDF.id}/preview`,
    );
    await files
      .getByRole('button', { name: 'Open owner-report.pdf', exact: true })
      .click();
    const bytes = await response;
    expect(bytes.ok()).toBe(true);
    expect(Buffer.from(await bytes.body()).equals(pdf)).toBe(true);
    const preview = page.getByRole('dialog', {
      name: 'owner-report.pdf',
      exact: true,
    });
    const firstPage = preview.getByRole('img', {
      name: 'PDF page 1 of 2',
      exact: true,
    });
    await expect(firstPage).toBeVisible({ timeout: 30000 });
    const blue = await firstPage.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        width: canvas.width,
        height: canvas.height,
        pixel: [
          ...canvas
            .getContext('2d')!
            .getImageData(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              1,
              1,
            ).data,
        ],
      };
    });
    expect(blue.width).toBeGreaterThan(200);
    expect(blue.height).toBeGreaterThan(150);
    expect(blue.pixel[2]).toBeGreaterThan(blue.pixel[0]! + 60);
    await expect(preview.locator('iframe, embed, object')).toHaveCount(0);
    await preview
      .getByRole('button', { name: 'Next PDF page', exact: true })
      .click();
    const secondPage = preview.getByRole('img', {
      name: 'PDF page 2 of 2',
      exact: true,
    });
    await expect(secondPage).toBeVisible();
    const red = await secondPage.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return [
        ...canvas
          .getContext('2d')!
          .getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data,
      ];
    });
    expect(red[0]).toBeGreaterThan(red[2]! + 60);
    await preview
      .getByRole('button', { name: 'Previous PDF page', exact: true })
      .click();
    await expect(
      preview.getByRole('img', { name: 'PDF page 1 of 2', exact: true }),
    ).toBeVisible();
    const { url } = await value<{ url: string }>(
      await owner.request.get(
        `/api/v1/rooms/${room.id}/attachments/${ownerPDF.id}?link=1`,
      ),
    );
    const storedPDF = await owner.request.get(url);
    expect(storedPDF.ok()).toBe(true);
    expect((await storedPDF.body()).equals(pdf)).toBe(true);
    expect(
      (
        await outsider.request.get(`/api/v1/rooms/${room.id}/files?type=pdf`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await outsider.request.get(
          `/api/v1/rooms/${room.id}/files/${ownerPDF.id}/preview`,
        )
      ).status(),
    ).toBe(404);
    await value(
      await owner.request.delete(
        `/api/v1/communities/${communityId}/members/${memberUser.id}`,
        { headers },
      ),
    );
    expect(
      (
        await member.request.get(
          `/api/v1/rooms/${room.id}/files/${ownerPDF.id}/preview`,
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

async function enableClips(page: Page, community: Community) {
  await enter(page, community);
  await page
    .getByRole('region', { name: `${community.name} · general`, exact: true })
    .getByRole('button', { name: 'Join voice', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Leave call', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Turn on camera', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Turn off camera', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Enable clip buffer', exact: true })
    .click();
  const consent = page.getByRole('dialog', {
    name: 'Capture moments with clips',
    exact: true,
  });
  await consent
    .getByRole('button', { name: 'Enable clip buffer', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Create clip', exact: true }),
  ).toBeEnabled();
}

/** Decode the actual downloaded bytes from a trusted click, including WebKit's
 * autoplay rules. The helper contributes no source modules or codecs. */
async function verifyExportedMedia(
  page: Page,
  bytes: Buffer,
  mimeType: string,
) {
  await page.evaluate(
    ({ data, mime }) => {
      const decoded = Uint8Array.from(atob(data), (character) =>
        character.charCodeAt(0),
      );
      const blob = new Blob([decoded], { type: mime });
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      video.src = url;
      video.load();
      const context = new AudioContext();
      const node = context.createMediaElementSource(video);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const silent = context.createGain();
      silent.gain.value = 0;
      node.connect(analyser).connect(silent).connect(context.destination);
      const button = document.createElement('button');
      button.textContent = 'Verify synthetic clip output';
      button.style.cssText =
        'position:fixed;inset:auto 12px 12px auto;z-index:2147483647;padding:12px;background:white;color:black';
      const result: {
        done: boolean;
        error?: string;
        duration?: number;
        width?: number;
        height?: number;
        rms?: number;
        pixel?: number[];
      } = { done: false };
      Object.defineProperty(window, '__productionClipDecode', {
        configurable: true,
        value: result,
      });
      button.onclick = () => {
        const resume = context.resume();
        const play = video.play();
        void (async () => {
          const wait = async (predicate: () => boolean) => {
            const deadline = performance.now() + 10000;
            while (!predicate()) {
              if (video.error) throw new Error(video.error.message);
              if (performance.now() > deadline)
                throw new Error('The downloaded clip could not decode');
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
          };
          try {
            await resume;
            await play;
            await wait(() => video.readyState >= 2 && video.videoWidth > 0);
            if (!Number.isFinite(video.duration)) {
              video.currentTime = 1e8;
              await wait(() => Number.isFinite(video.duration));
              video.currentTime = 0;
              await video.play();
            }
            result.duration = video.duration;
            const samples = new Float32Array(analyser.fftSize);
            await wait(() => {
              analyser.getFloatTimeDomainData(samples);
              result.rms = Math.sqrt(
                samples.reduce((sum, sample) => sum + sample * sample, 0) /
                  samples.length,
              );
              return result.rms > 0.01;
            });
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const drawing = canvas.getContext('2d')!;
            drawing.drawImage(video, 0, 0);
            result.width = video.videoWidth;
            result.height = video.videoHeight;
            result.pixel = [
              ...drawing.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
              ).data,
            ];
          } catch (failure) {
            result.error =
              failure instanceof Error ? failure.message : String(failure);
          } finally {
            video.pause();
            video.removeAttribute('src');
            video.load();
            node.disconnect();
            analyser.disconnect();
            silent.disconnect();
            URL.revokeObjectURL(url);
            await context.close();
            button.remove();
            result.done = true;
          }
        })();
      };
      document.body.append(button);
    },
    { data: bytes.toString('base64'), mime: mimeType },
  );
  await page
    .getByRole('button', { name: 'Verify synthetic clip output', exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __productionClipDecode: { done: boolean } })
              .__productionClipDecode.done,
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          __productionClipDecode: {
            error?: string;
            duration: number;
            width: number;
            height: number;
            rms: number;
            pixel: number[];
          };
        }
      ).__productionClipDecode,
  );
  expect(result.error).toBeUndefined();
  expect(result.duration).toBeGreaterThan(0.9);
  expect(result.duration).toBeLessThan(3);
  expect([result.width, result.height]).toEqual([1280, 720]);
  expect(result.rms).toBeGreaterThan(0.01);
  expect(result.pixel.slice(0, 3).some((channel) => channel > 80)).toBe(true);
}

test('optimized clips borrow muted call tracks, cancel rendering, preview, trim, export and publish private playable media', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const context = await browser.newContext({ baseURL, acceptDownloads: true });
  let communityId = '';
  let page: Page | undefined;
  try {
    await requireClipCapture(context, browser.browserType().name());
    await context.addInitScript(installSyntheticCapture);
    const suffix = `${Date.now()}-clip-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Production Clip Owner', suffix);
    const community = await createCommunity(context, suffix);
    communityId = community.id;
    const room = community.channels[0]!;
    page = await context.newPage();
    await enableClips(page, community);
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Mute microphone', exact: true })
      .click();
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const state = (window as unknown as SyntheticCaptureWindow)
            .__communityCapture;
          const sourceRecorders = state.recorders.filter(
            (recorder) =>
              recorder.state === 'recording' &&
              recorder.stream.getAudioTracks().length === 1 &&
              recorder.stream.getVideoTracks().length === 0,
          );
          return (
            sourceRecorders.length > 0 &&
            sourceRecorders.every(
              (recorder) => !recorder.stream.getAudioTracks()[0]!.enabled,
            )
          );
        }),
      )
      .toBe(true);
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Unmute microphone', exact: true })
      .click();
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Create clip', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Create clip',
      exact: true,
    });
    await expect(editor).toBeVisible();
    const title = `Production moment ${suffix}`;
    await editor.getByLabel('Clip title', { exact: true }).fill(title);
    const start = editor.getByRole('slider', {
      name: 'Clip start',
      exact: true,
    });
    await start.focus();
    await start.press('Home');
    for (let step = 0; step < 5; step++) await start.press('ArrowRight');
    const end = editor.getByRole('slider', { name: 'Clip end', exact: true });
    await end.focus();
    await end.press('Home');
    for (let step = 0; step < 5; step++) await end.press('ArrowRight');
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Previewing');
    await expect(
      editor.getByRole('button', { name: 'Prepare download', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await editor
      .getByRole('button', { name: 'Prepare download', exact: true })
      .click();
    await expect(editor.getByRole('status')).toContainText('Rendering clip');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      editor.getByRole('button', { name: 'Prepare download', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as SyntheticCaptureWindow
        ).__communityCapture.inputs.every(
          (track) => track.readyState === 'live',
        ),
      ),
    ).toBe(true);
    await editor
      .getByRole('button', { name: 'Prepare download', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: 'Download', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const downloadPromise = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    const downloaded = await download.path();
    expect(downloaded).not.toBeNull();
    const bytes = readFileSync(downloaded!);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    await editor
      .getByRole('button', { name: 'Publish clip', exact: true })
      .click();
    await expect(editor).toBeHidden({ timeout: 45000 });
    await expect(
      page.getByRole('log', { name: 'Messages', exact: true }),
    ).toContainText(title);
    const { messages } = await value<{
      messages: { id: string; body: string; attachments: Attachment[] }[];
    }>(await context.request.get(`/api/v1/rooms/${room.id}/messages`));
    const clip = messages.find((message) => message.body.includes(title))!;
    expect(clip.attachments).toHaveLength(1);
    const attachment = clip.attachments[0]!;
    expect(attachment.content_type).toMatch(/^video\//);
    const { url } = await value<{ url: string }>(
      await context.request.get(
        `/api/v1/rooms/${room.id}/attachments/${attachment.id}?link=1&inline=1`,
      ),
    );
    const stored = await context.request.get(url);
    expect(stored.ok()).toBe(true);
    expect((await stored.body()).equals(bytes)).toBe(true);
    const row = page.locator(`[data-message-id="${clip.id}"]`);
    await row.getByRole('button', { name: 'Watch video', exact: true }).click();
    await expect
      .poll(() =>
        row
          .locator('video')
          .evaluate((element) => (element as HTMLVideoElement).videoWidth),
      )
      .toBe(1280);
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Stop clip buffer', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Enable clip buffer', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const state = (window as unknown as SyntheticCaptureWindow)
            .__communityCapture;
          const sourceRecorders = state.recorders.filter(
            (recorder) => recorder.stream.getTracks().length === 1,
          );
          return (
            sourceRecorders.length > 1 &&
            sourceRecorders.every(
              (recorder) =>
                recorder.state === 'inactive' &&
                recorder.stream.getTracks()[0]!.readyState === 'live',
            )
          );
        }),
      )
      .toBe(true);
    const borrowed = await page.evaluate(() => {
      const state = (window as unknown as SyntheticCaptureWindow)
        .__communityCapture;
      const microphones = state.recorders
        .filter(
          (recorder) =>
            recorder.stream.getAudioTracks().length === 1 &&
            recorder.stream.getVideoTracks().length === 0,
        )
        .map((recorder) => recorder.stream.getAudioTracks()[0]!.id);
      return {
        ids: [...new Set(microphones)],
        audioClones: state.clones.filter((clone) => clone.kind === 'audio')
          .length,
      };
    });
    expect(borrowed.ids).toHaveLength(1);
    expect(borrowed.audioClones).toBe(0);
    await revealCallControls(page);
    await page.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const state = (window as unknown as SyntheticCaptureWindow)
            .__communityCapture;
          return (
            state.inputs.every((track) => track.readyState === 'ended') &&
            state.inputContexts.every((clock) => clock.state === 'closed')
          );
        }),
      )
      .toBe(true);
    await verifyExportedMedia(page, bytes, attachment.content_type);
    await download.delete();
  } finally {
    if (page && !page.isClosed())
      await page
        .evaluate(() =>
          (
            window as unknown as SyntheticCaptureWindow
          ).__communityCapture.cleanup(),
        )
        .catch(() => {});
    if (communityId)
      await context.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await context.close();
  }
});

test('voice permission revocation cancels an active clip render, closes its editor and releases original capture', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ baseURL });
  let communityId = '';
  let page: Page | undefined;
  try {
    await requireClipCapture(context, browser.browserType().name());
    await context.addInitScript(installSyntheticCapture);
    const suffix = `${Date.now()}-revoke-${Math.random().toString(36).slice(2)}`;
    await login(context, 'Production Clip Revocation', suffix);
    const community = await createCommunity(context, suffix);
    communityId = community.id;
    const room = community.channels[0]!;
    page = await context.newPage();
    await enableClips(page, community);
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Create clip', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Create clip',
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor
      .getByRole('button', { name: 'Prepare download', exact: true })
      .click();
    await expect(editor.getByRole('status')).toContainText('Rendering clip');
    await value(
      await context.request.patch(
        `/api/v1/communities/${communityId}/channels/${room.id}`,
        { headers, data: { channel_type: 'announcement' } },
      ),
    );
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Leave call', exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const state = (window as unknown as SyntheticCaptureWindow)
            .__communityCapture;
          return (
            state.inputs.every((track) => track.readyState === 'ended') &&
            state.inputContexts.every((clock) => clock.state === 'closed') &&
            state.recorders.every((recorder) => recorder.state === 'inactive')
          );
        }),
      )
      .toBe(true);
    const { messages } = await value<{ messages: unknown[] }>(
      await context.request.get(`/api/v1/rooms/${room.id}/messages`),
    );
    expect(messages).toHaveLength(0);
  } finally {
    if (page && !page.isClosed())
      await page
        .evaluate(() =>
          (
            window as unknown as SyntheticCaptureWindow
          ).__communityCapture.cleanup(),
        )
        .catch(() => {});
    if (communityId)
      await context.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await context.close();
  }
});
