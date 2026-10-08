import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
};
type Message = { id: string; body: string; attachments: Attachment[] };

async function value<T>(
  response: Pick<APIResponse, 'ok' | 'text' | 'json'>,
): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function login(context: BrowserContext, name: string, suffix: string) {
  await value(
    await context.request.post('/api/v1/auth/dev', {
      headers,
      data: { name, email: `${name}-${suffix}@example.test` },
    }),
  );
}

async function sendMessage(page: Page, room: string) {
  const delivered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/rooms/${room}/messages`,
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return (await value<{ message: Message }>(await delivered)).message;
}

async function imageLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const image = element as HTMLImageElement;
        return (
          image.complete &&
          image.naturalWidth === 32 &&
          image.naturalHeight === 24
        );
      }),
    )
    .toBe(true);
}

async function playVideo(video: Locator) {
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return (
          media.videoWidth === 320 &&
          media.videoHeight === 180 &&
          media.duration > 0
        );
      }),
    )
    .toBe(true);
  await video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await video.evaluate((element) => (element as HTMLVideoElement).pause());
}

async function downloadOriginal(
  page: Page,
  context: BrowserContext,
  button: Locator,
  room: string,
  attachment: Attachment,
  expected: Buffer,
) {
  const observed: { download?: Download } = {};
  const watchedPages = new Set<Page>([page]);
  const receivedDownload = (download: Download) => {
    observed.download ??= download;
  };
  const watchPopup = (popup: Page) => {
    watchedPages.add(popup);
    popup.on('download', receivedDownload);
  };
  // The user gesture opens about:blank before the authorization request resolves.
  // Listen to that popup immediately, and to the source page for anchor fallback.
  context.on('page', watchPopup);
  page.on('download', receivedDownload);
  const authorizedLink = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname === `/api/v1/rooms/${room}/attachments/${attachment.id}` &&
      url.searchParams.get('link') === '1' &&
      !url.searchParams.has('inline')
    );
  });
  try {
    await button.click();
    const { url } = await value<{ url: string }>(await authorizedLink);
    await expect
      .poll(() => observed.download?.suggestedFilename(), {
        timeout: 30_000,
        message: `The browser should download ${attachment.filename}`,
      })
      .toBe(attachment.filename);
    const download = observed.download;
    if (!download)
      throw new Error(`No browser download for ${attachment.filename}`);
    expect(await download.failure()).toBeNull();
    const downloadedFile = await download.path();
    expect(readFileSync(downloadedFile).equals(expected)).toBe(true);

    // Also verify the private-object response used by the browser action.
    const object = await context.request.get(url);
    expect(object.status()).toBe(200);
    expect(object.headers()['content-type']).toBe(attachment.content_type);
    expect(object.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(object.headers()['content-disposition']).toContain(
      attachment.filename,
    );
    expect((await object.body()).equals(expected)).toBe(true);
  } finally {
    context.off('page', watchPopup);
    for (const watched of watchedPages)
      watched.off('download', receivedDownload);
    if (observed.download) {
      await observed.download.cancel().catch(() => {});
      await observed.download.delete().catch(() => {});
    }
    await Promise.allSettled(
      [...watchedPages]
        .filter((popup) => popup !== page)
        .map((popup) => popup.close()),
    );
  }
}

test('real S3 attachments preview locally, retry, open after sending and download originals above 10 MiB', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL, acceptDownloads: true });
  const outsider = await browser.newContext({ baseURL });
  let room = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(owner, 'attachment-owner', suffix);
    await login(outsider, 'attachment-outsider', suffix);
    const created = await value<{ room: { id: string; name: string } }>(
      await owner.request.post('/api/v1/rooms', {
        headers,
        data: { name: `Attachment lab ${suffix}` },
      }),
    );
    room = created.room.id;
    const fixture = readFileSync(
      path.join(__dirname, 'fixtures', 'attachment-preview.mp4'),
    );
    // An ignored, valid top-level ISO BMFF free box preserves the synthetic
    // video's media tracks while exercising the former 10 MiB upload ceiling.
    const freeBox = Buffer.alloc(16 * 1024 * 1024);
    freeBox.writeUInt32BE(freeBox.length, 0);
    freeBox.write('free', 4, 4, 'ascii');
    const mp4 = Buffer.concat([fixture, freeBox]);
    expect(mp4.length).toBeGreaterThan(10 * 1024 * 1024);
    const config = await value<{
      attachments: { available: boolean; max_file_bytes: number };
    }>(await owner.request.get('/api/v1/config'));
    expect(config.attachments.available).toBe(true);
    expect(config.attachments.max_file_bytes).toBeGreaterThanOrEqual(
      mp4.length,
    );

    const page = await owner.newPage();
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Rooms', exact: true })
      .click();
    await page
      .getByRole('button', { name: created.room.name, exact: true })
      .click();
    const composer = page.getByRole('textbox', {
      name: `Message ${created.room.name}`,
      exact: true,
    });
    await expect(composer).toBeVisible();
    const pngData = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#5577cc';
      context.fillRect(0, 0, 32, 24);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const png = Buffer.from(pngData, 'base64');
    const imageName = 'local-preview.png';
    await page.getByLabel('Choose attachments', { exact: true }).setInputFiles({
      name: imageName,
      mimeType: 'image/png',
      buffer: png,
    });
    const pendingImage = page.getByLabel(`Pending attachment ${imageName}`, {
      exact: true,
    });
    await expect(pendingImage.getByRole('status')).toContainText(
      'Ready to upload',
    );
    const localImage = pendingImage.getByRole('img', {
      name: imageName,
      exact: true,
    });
    await expect(localImage).toHaveAttribute('src', /^blob:/);
    await imageLoaded(localImage);
    await pendingImage
      .getByRole('button', { name: `Preview ${imageName}`, exact: true })
      .click();
    const localViewer = page.getByRole('dialog', {
      name: imageName,
      exact: true,
    });
    await expect(localViewer).toContainText('Local preview');
    await imageLoaded(
      localViewer.getByRole('img', { name: imageName, exact: true }),
    );
    await expect(
      localViewer.getByRole('button', { name: 'Download', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(localViewer).toBeHidden();

    const uploadPath = `**/api/v1/rooms/${room}/uploads/*/chunks`;
    let interrupted = false;
    await page.route(uploadPath, async (route) => {
      if (route.request().method() === 'POST' && !interrupted) {
        interrupted = true;
        await route.abort('failed');
      } else await route.continue();
    });
    await composer.fill('Image draft survives interrupted upload');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(pendingImage.getByRole('alert')).toContainText(
      'Upload interrupted',
    );
    expect(interrupted).toBe(true);
    await expect(composer).toHaveValue(
      'Image draft survives interrupted upload',
    );
    await imageLoaded(localImage);
    await page.unroute(uploadPath);
    await pendingImage
      .getByRole('button', { name: 'Retry file', exact: true })
      .click();
    await expect(pendingImage.getByRole('status')).toContainText(
      'Uploaded · ready to send',
    );
    const beforeSending = await value<{ messages: Message[] }>(
      await owner.request.get(`/api/v1/rooms/${room}/messages`),
    );
    expect(beforeSending.messages).toHaveLength(0);
    const imageMessage = await sendMessage(page, room);
    expect(imageMessage.attachments).toHaveLength(1);
    const image = imageMessage.attachments[0];
    expect(image).toMatchObject({
      filename: imageName,
      content_type: 'image/png',
      size_bytes: png.length,
    });
    await expect(pendingImage).toHaveCount(0);
    const sentImage = page.locator(`[data-message-id="${imageMessage.id}"]`);
    await imageLoaded(
      sentImage.getByRole('img', { name: imageName, exact: true }),
    );
    await expect(
      sentImage.getByRole('button', {
        name: `Download ${imageName}`,
        exact: true,
      }),
    ).toBeVisible();
    await sentImage
      .getByRole('button', { name: `Open image ${imageName}`, exact: true })
      .click();
    const sentImageViewer = page.getByRole('dialog', {
      name: imageName,
      exact: true,
    });
    const remoteImage = sentImageViewer.getByRole('img', {
      name: imageName,
      exact: true,
    });
    await imageLoaded(remoteImage);
    await expect(remoteImage).toHaveAttribute('src', /^https?:\/\//);
    await downloadOriginal(
      page,
      owner,
      sentImageViewer.getByRole('button', { name: 'Download', exact: true }),
      room,
      image,
      png,
    );
    await page.keyboard.press('Escape');
    await expect(sentImageViewer).toBeHidden();

    const videoName = 'large-synthetic-video.mp4';
    await page.getByLabel('Choose attachments', { exact: true }).setInputFiles({
      name: videoName,
      mimeType: 'video/mp4',
      buffer: mp4,
    });
    const pendingVideo = page.getByLabel(`Pending attachment ${videoName}`, {
      exact: true,
    });
    const localVideo = pendingVideo.locator('video');
    await expect(localVideo).toHaveAttribute('src', /^blob:/);
    await playVideo(localVideo);
    await composer.fill('MP4 remains playable above the old upload limit');
    const videoMessage = await sendMessage(page, room);
    expect(videoMessage.attachments).toHaveLength(1);
    const video = videoMessage.attachments[0];
    expect(video).toMatchObject({
      filename: videoName,
      content_type: 'video/mp4',
      size_bytes: mp4.length,
    });
    await expect(pendingVideo).toHaveCount(0);
    const sentVideo = page.locator(`[data-message-id="${videoMessage.id}"]`);
    await expect(
      sentVideo.getByRole('button', {
        name: `Download ${videoName}`,
        exact: true,
      }),
    ).toBeVisible();
    await sentVideo
      .getByRole('button', { name: 'Watch video', exact: true })
      .click();
    await playVideo(sentVideo.locator('video'));
    await sentVideo
      .getByRole('button', { name: `Open ${videoName}`, exact: true })
      .click();
    const videoViewer = page.getByRole('dialog', {
      name: videoName,
      exact: true,
    });
    const remoteVideo = videoViewer.locator('video');
    await expect(remoteVideo).toHaveAttribute('src', /^https?:\/\//);
    await playVideo(remoteVideo);
    await downloadOriginal(
      page,
      owner,
      videoViewer.getByRole('button', { name: 'Download', exact: true }),
      room,
      video,
      mp4,
    );
    await page.keyboard.press('Escape');
    await expect(videoViewer).toBeHidden();

    const history = await value<{ messages: Message[] }>(
      await owner.request.get(`/api/v1/rooms/${room}/messages`),
    );
    expect(history.messages).toHaveLength(2);
    expect(
      history.messages.find((message) => message.id === videoMessage.id)
        ?.attachments[0],
    ).toMatchObject({
      id: video.id,
      filename: videoName,
      content_type: 'video/mp4',
      size_bytes: mp4.length,
    });
    for (const attachment of [image, video]) {
      expect(
        (
          await outsider.request.get(
            `/api/v1/rooms/${room}/attachments/${attachment.id}?link=1&inline=1`,
          )
        ).status(),
      ).toBe(403);
      expect(
        (
          await outsider.request.get(
            `/api/v1/rooms/${room}/attachments/${attachment.id}?link=1`,
          )
        ).status(),
      ).toBe(403);
    }
  } finally {
    if (room) await owner.request.delete(`/api/v1/rooms/${room}`, { headers });
    await owner.close();
    await outsider.close();
  }
});
