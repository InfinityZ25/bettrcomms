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
type Room = { id: string; name: string; community_id: string };
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
  return (
    await value<{ user: User }>(
      await context.request.post('/api/v1/auth/dev', {
        headers,
        data: { name, email: `${name}-${suffix}@example.test` },
      }),
    )
  ).user;
}
async function selectRoom(page: Page, room: Room) {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await page.getByRole('button', { name: room.name, exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: `Message ${room.name}`, exact: true }),
  ).toBeVisible();
}
async function send(page: Page, room: Room) {
  const delivered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/rooms/${room.id}/messages`,
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return (await value<{ message: Message }>(await delivered)).message;
}
function syntheticPDF() {
  const stream = 'BT /F1 18 Tf 20 45 Td (Storage preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(document);
}

test('resumes committed S3 chunks after reload, renders safe PDF library and enforces room storage policy', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let room: Room | undefined;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await login(owner, 'storage-owner', suffix);
    const peer = await login(member, 'storage-member', suffix);
    const created = await value<{ room: Room }>(
      await owner.request.post('/api/v1/rooms', {
        headers,
        data: { name: `Storage ${suffix}` },
      }),
    );
    room = created.room;
    const community = (
      await value<{ community: { id: string; name: string } }>(
        await owner.request.get(`/api/v1/communities/${room.community_id}`),
      )
    ).community;
    const friendship = await value<{ request: { id: string } }>(
      await owner.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: peer.id },
      }),
    );
    await value(
      await member.request.post(
        `/api/v1/friends/requests/${friendship.request.id}/accept`,
        { headers, data: {} },
      ),
    );
    await value(
      await owner.request.post(`/api/v1/communities/${community.id}/members`, {
        headers,
        data: { user_id: peer.id },
      }),
    );
    expect(
      (
        await member.request.get(`/api/v1/communities/${community.id}/storage`)
      ).status(),
    ).toBe(403);
    expect(
      (
        await member.request.patch(
          `/api/v1/communities/${community.id}/storage`,
          { headers, data: { quota_bytes: 1, retention_days: 1 } },
        )
      ).status(),
    ).toBe(403);

    const page = await owner.newPage();
    await page.goto('/');
    await selectRoom(page, room);
    const original = readFileSync(
      path.join(__dirname, 'fixtures', 'attachment-preview.mp4'),
    );
    const padding = Buffer.alloc(16 * 1024 * 1024);
    padding.writeUInt32BE(padding.length, 0);
    padding.write('free', 4, 4, 'ascii');
    const mp4 = Buffer.concat([original, padding]);
    const filename = 'durable-upload.mp4';
    const chunkPath = `**/api/v1/rooms/${room.id}/uploads/*/chunks`;
    let interrupted = false;
    let afterReload = false;
    let uploadId = '';
    const resumedOffsets: number[] = [];
    await page.route(chunkPath, async (route) => {
      const offset = Number(route.request().headers()['upload-offset']);
      uploadId = new URL(route.request().url()).pathname.split('/').at(-2)!;
      if (afterReload) resumedOffsets.push(offset);
      if (!interrupted && offset > 0) {
        interrupted = true;
        await route.abort('failed');
      } else await route.continue();
    });
    await page
      .getByLabel('Choose attachments', { exact: true })
      .setInputFiles({ name: filename, mimeType: 'video/mp4', buffer: mp4 });
    await page
      .getByRole('textbox', { name: `Message ${room.name}`, exact: true })
      .fill('Durable draft and multipart upload');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      page
        .getByLabel(`Pending attachment ${filename}`, { exact: true })
        .getByRole('alert'),
    ).toContainText('Upload interrupted');
    expect(interrupted).toBe(true);
    const stored = await value<{ upload: { offset: number; state: string } }>(
      await owner.request.get(`/api/v1/rooms/${room.id}/uploads/${uploadId}`),
    );
    expect(stored.upload.offset).toBe(8 * 1024 * 1024);
    expect(stored.upload.state).toBe('uploading');
    const originalUploadId = uploadId;
    afterReload = true;
    await page.reload();
    await selectRoom(page, room);
    await expect(
      page.getByRole('textbox', { name: `Message ${room.name}`, exact: true }),
    ).toHaveValue('Durable draft and multipart upload');
    const pending = page.getByLabel(`Pending attachment ${filename}`, {
      exact: true,
    });
    await expect(
      pending.getByLabel(`Preview ${filename}`, { exact: true }),
    ).toBeVisible();
    await expect(
      pending.getByLabel(`Preview ${filename}`, { exact: true }),
    ).toHaveAttribute('src', /^blob:/);
    await expect(pending.getByRole('alert')).toHaveCount(0);
    const sharedVideo = await send(page, room);
    expect(sharedVideo.attachments[0].id).toBe(originalUploadId);
    expect(resumedOffsets).toEqual([8 * 1024 * 1024, 16 * 1024 * 1024]);
    await page.unroute(chunkPath);
    const link = await value<{ url: string }>(
      await owner.request.get(
        `/api/v1/rooms/${room.id}/attachments/${originalUploadId}?link=1`,
      ),
    );
    const downloaded = await owner.request.get(link.url);
    expect(downloaded.ok()).toBe(true);
    expect(await downloaded.body()).toEqual(mp4);

    const pdfName = 'canvas-only-preview.pdf';
    const pdf = syntheticPDF();
    await page
      .getByLabel('Choose attachments', { exact: true })
      .setInputFiles({
        name: pdfName,
        mimeType: 'application/pdf',
        buffer: pdf,
      });
    await page
      .getByRole('textbox', { name: `Message ${room.name}`, exact: true })
      .fill('PDF shared with the room');
    const sharedPDF = await send(page, room);
    expect(sharedPDF.attachments[0].content_type).toBe('application/pdf');
    await page
      .getByRole('button', { name: 'Channel file library', exact: true })
      .click();
    const library = page.getByRole('dialog', {
      name: 'Channel files',
      exact: true,
    });
    await library
      .getByRole('combobox', { name: 'File type', exact: true })
      .selectOption('pdf');
    await library
      .getByRole('combobox', { name: 'File author', exact: true })
      .selectOption(user.id);
    const today = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    });
    await library.getByLabel('Files from date', { exact: true }).fill(today);
    await library.getByLabel('Files through date', { exact: true }).fill(today);
    await library
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    await expect(
      library
        .getByRole('list', { name: 'Channel files', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(1);
    await expect(library).toContainText(pdfName);
    await expect(library).not.toContainText(filename);
    await library
      .getByRole('button', { name: `Open ${pdfName}`, exact: true })
      .click();
    const preview = page.getByRole('dialog', { name: pdfName, exact: true });
    const canvas = preview.getByRole('img', {
      name: 'PDF page 1 of 1',
      exact: true,
    });
    await expect(canvas).toBeVisible();
    await expect(preview).toContainText('Page 1 of 1');
    expect(
      await canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i + 3] > 0 && pixels[i] < 200) return true;
        return false;
      }),
    ).toBe(true);
    await expect(preview.locator('iframe, object, embed, a')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(preview).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(library).toBeHidden();

    await page
      .getByRole('button', {
        name: `${community.name} room settings`,
        exact: true,
      })
      .click();
    const settings = page.getByRole('dialog', {
      name: community.name,
      exact: true,
    });
    await settings
      .getByRole('button', { name: 'Storage', exact: true })
      .click();
    await settings
      .getByLabel('Room storage quota MiB', { exact: true })
      .fill('1');
    await settings.getByLabel('File retention days', { exact: true }).fill('1');
    page.once('dialog', (dialog) => dialog.accept());
    await settings
      .getByRole('button', { name: 'Save storage settings', exact: true })
      .click();
    await expect(settings.getByRole('status')).toContainText(
      'Storage settings saved',
    );
    const policy = await value<{
      storage: {
        quota_bytes: number;
        retention_days: number;
        used_bytes: number;
        reserved_bytes: number;
      };
    }>(await owner.request.get(`/api/v1/communities/${community.id}/storage`));
    expect(policy.storage.quota_bytes).toBe(1024 * 1024);
    expect(policy.storage.used_bytes).toBe(mp4.length + pdf.length);
    expect(policy.storage.reserved_bytes).toBe(0);
    expect(policy.storage.retention_days).toBe(1);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page
      .getByLabel('Choose attachments', { exact: true })
      .setInputFiles({
        name: 'quota-denied.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('quota must be enforced'),
      });
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      page
        .getByLabel('Pending attachment quota-denied.txt', { exact: true })
        .getByRole('alert'),
    ).toContainText('quota');
    const history = await value<{ messages: Message[] }>(
      await owner.request.get(`/api/v1/rooms/${room.id}/messages`),
    );
    expect(history.messages).toHaveLength(2);
  } finally {
    if (room)
      await owner.request
        .delete(`/api/v1/communities/${room.community_id}`, { headers })
        .catch(() => {});
    await Promise.all([owner.close(), member.close()]);
  }
});
