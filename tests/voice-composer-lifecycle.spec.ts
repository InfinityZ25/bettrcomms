import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

async function mountComposer(page: Page) {
  await page.goto(baseURL);
  await expect(page.locator('#signin')).toBeVisible();
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const Composer = (await import('/src/features/chat/MessageComposer.tsx')).default;
    const host = document.createElement('div');
    host.id = 'voice-composer-fixture';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);z-index:9999;overflow:auto';
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const OriginalRecorder = window.MediaRecorder;
    const tracks: MediaStreamTrack[] = [];
    const deferredCaptures: (() => void)[] = [];
    const state = { sent: 0, files: [] as { file: File; durationMs: number }[], voidResult: false, holdCapture: false, recorders: 0 };
    window.MediaRecorder = class extends OriginalRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        state.recorders++;
      }
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await originalCapture(constraints);
      tracks.push(...stream.getTracks());
      if (state.holdCapture) await new Promise<void>((resolve) => deferredCaptures.push(resolve));
      return stream;
    };
    let props: Record<string, unknown> = {
      userId: 'voice-author', recordingKey: 'voice-author:room-one', draft: 'Keep this draft',
      editing: false, reply: null, busy: false, blocked: false, attachmentsBlocked: false,
      suggested: [], suggestion: 0, attachments: [], inputRef: React.createRef(), label: 'fixture',
      onDraft: (draft: string) => render({ draft }), onSuggestion: () => {}, onMention: () => {},
      onSend: (event?: Event) => { event?.preventDefault(); state.sent++; }, onCancel: () => {},
      onFiles: () => {}, onRemoveFile: () => {}, onTypingStop: () => {},
      onVoiceFile: (file: File, durationMs: number) => {
        state.files.push({ file, durationMs });
        return state.voidResult ? undefined : true;
      },
    };
    function render(next: Record<string, unknown> = {}) {
      props = { ...props, ...next };
      root.render(React.createElement(Composer, props));
    }
    const releaseCapture = () => { state.holdCapture = false; deferredCaptures.splice(0).forEach((resolve) => resolve()); };
    (window as any).__voiceFixture = { render, tracks, state, releaseCapture, unmount: () => {
      root.unmount(); releaseCapture(); navigator.mediaDevices.getUserMedia = originalCapture; window.MediaRecorder = OriginalRecorder; host.remove();
    } };
    render();
  });
  await expect(page.locator('#voice-composer-fixture').getByRole('button', { name: 'Record voice note', exact: true })).toBeVisible();
  return page.locator('#voice-composer-fixture');
}

async function update(page: Page, props: Record<string, unknown>) {
  await page.evaluate((next) => (window as any).__voiceFixture.render(next), props);
}

async function trackStates(page: Page) {
  return page.evaluate(() => (window as any).__voiceFixture.tracks.map((track: MediaStreamTrack) => track.readyState));
}

test('busy, cooldown, edit and attachment limits preserve recording and local review', async ({ page }) => {
  const composer = await mountComposer(page);
  try {
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(composer.getByText('0:01 / 2:00', { exact: true })).toBeVisible();
    expect(await trackStates(page)).toEqual(['live']);
    await update(page, { busy: true });
    await expect(composer.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled();
    await expect(composer.getByRole('button', { name: 'Discard recording', exact: true })).toBeEnabled();
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    expect(await trackStates(page)).toEqual(['live']);
    await update(page, { busy: false, blocked: true, attachmentsBlocked: false, blockedReason: 'Slow mode: wait before sending another message.' });
    await expect(composer.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled();
    expect(await trackStates(page)).toEqual(['live']);
    await composer.getByRole('button', { name: 'Stop recording', exact: true }).click();
    const review = composer.getByLabel('Preview your voice note', { exact: true });
    await expect(review).toHaveAttribute('src', /^blob:/);
    const localURL = await review.getAttribute('src');
    expect(await trackStates(page)).toEqual(['ended']);
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeDisabled();
    await update(page, { busy: true, blocked: false, blockedReason: '' });
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeDisabled();
    await expect(review).toHaveAttribute('src', localURL!);
    const attachments = Array.from({ length: 4 }, (_, index) => ({ id: `file-${index}`, filename: `file-${index}.txt`, content_type: 'text/plain', size_bytes: 1 }));
    await update(page, { busy: false, attachments });
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeDisabled();
    await expect(review).toHaveAttribute('src', localURL!);
    await update(page, { editing: true });
    await expect(composer.getByRole('button', { name: 'Save message', exact: true })).toBeDisabled();
    await expect(review).toHaveAttribute('src', localURL!);
    await update(page, { editing: false, attachments: [] });
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeEnabled();
    await composer.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.sent)).toBe(0);
    // A valid void callback is an acceptance, just like a callback returning true.
    await page.evaluate(() => { (window as any).__voiceFixture.state.voidResult = true; });
    await composer.getByRole('button', { name: 'Attach voice note', exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(await page.evaluate(() => {
      const { files } = (window as any).__voiceFixture.state;
      return files.length === 1 && files[0].file instanceof File && files[0].file.size > 0 && files[0].durationMs >= 250;
    })).toBe(true);
    await expect(composer.getByRole('textbox', { name: 'Message fixture', exact: true })).toHaveValue('Keep this draft');
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await update(page, { busy: true });
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await composer.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.sent)).toBe(0);
    await update(page, { busy: false, blocked: true });
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await composer.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.sent)).toBe(0);
    await update(page, { blocked: false });
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await composer.getByRole('button', { name: 'Send message', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.sent)).toBe(1);
  } finally { await page.evaluate(() => (window as any).__voiceFixture?.unmount()); }
});

test('revoked posting stops capture with review preserved; conversation and account changes release it', async ({ page }) => {
  const composer = await mountComposer(page);
  try {
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(composer.getByText('0:01 / 2:00', { exact: true })).toBeVisible();
    await update(page, { blocked: true, attachmentsBlocked: true, blockedReason: 'Posting is temporarily restricted in this channel.' });
    const review = composer.getByLabel('Preview your voice note', { exact: true });
    await expect(review).toHaveAttribute('src', /^blob:/);
    const localURL = await review.getAttribute('src');
    expect(await trackStates(page)).toEqual(['ended']);
    await expect(composer.getByText(/Posting permission changed, so recording has stopped/)).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeDisabled();
    await expect(composer.getByRole('button', { name: 'Record again', exact: true })).toBeDisabled();
    await expect(composer.getByRole('button', { name: 'Discard', exact: true })).toBeEnabled();
    await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await update(page, { blocked: false, attachmentsBlocked: false, blockedReason: '' });
    await expect(composer.getByRole('button', { name: 'Attach voice note', exact: true })).toBeEnabled();
    await expect(review).toHaveAttribute('src', localURL!);
    await composer.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(await page.evaluate(async (url) => { try { await fetch(url!); return false; } catch { return true; } }, localURL)).toBe(true);
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect.poll(() => trackStates(page)).toEqual(['ended', 'live']);
    await update(page, { recordingKey: 'voice-author:room-two' });
    await expect.poll(() => trackStates(page)).toEqual(['ended', 'ended']);
    await expect(composer.getByRole('button', { name: 'Stop recording', exact: true })).toHaveCount(0);
    await expect(composer.getByLabel('Record a voice note', { exact: true })).toHaveCount(0);
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(composer.getByText('0:01 / 2:00', { exact: true })).toBeVisible();
    await composer.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(review).toHaveAttribute('src', /^blob:/);
    const otherURL = await review.getAttribute('src');
    await update(page, { userId: 'other-author' });
    await expect(review).toHaveCount(0);
    await expect(composer.getByLabel('Record a voice note', { exact: true })).toHaveCount(0);
    expect(await trackStates(page)).toEqual(['ended', 'ended', 'ended']);
    expect(await page.evaluate(async (url) => { try { await fetch(url!); return false; } catch { return true; } }, otherURL)).toBe(true);
  } finally { await page.evaluate(() => (window as any).__voiceFixture?.unmount()); }
});

test('late microphone access after restriction or a conversation change releases tracks without starting a recorder', async ({ page }) => {
  const composer = await mountComposer(page);
  try {
    await page.evaluate(() => { (window as any).__voiceFixture.state.holdCapture = true; });
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(composer.getByText('Waiting for microphone access…', { exact: true })).toBeVisible();
    await expect.poll(() => trackStates(page)).toEqual(['live']);
    await update(page, { blocked: true, attachmentsBlocked: true });
    await expect(composer.getByRole('button', { name: 'Start recording', exact: true })).toBeDisabled();
    await page.evaluate(() => (window as any).__voiceFixture.releaseCapture());
    await expect.poll(() => trackStates(page)).toEqual(['ended']);
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.recorders)).toBe(0);
    await expect(composer.getByRole('button', { name: 'Stop recording', exact: true })).toHaveCount(0);
    await composer.getByRole('button', { name: 'Close voice recorder', exact: true }).click();
    await update(page, { blocked: false, attachmentsBlocked: false });
    await page.evaluate(() => { (window as any).__voiceFixture.state.holdCapture = true; });
    await composer.getByRole('button', { name: 'Record voice note', exact: true }).click();
    await composer.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect.poll(() => trackStates(page)).toEqual(['ended', 'live']);
    await update(page, { recordingKey: 'voice-author:room-two' });
    await expect(composer.getByLabel('Record a voice note', { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).__voiceFixture.releaseCapture());
    await expect.poll(() => trackStates(page)).toEqual(['ended', 'ended']);
    expect(await page.evaluate(() => (window as any).__voiceFixture.state.recorders)).toBe(0);
    await expect(composer.getByRole('button', { name: 'Stop recording', exact: true })).toHaveCount(0);
  } finally { await page.evaluate(() => (window as any).__voiceFixture?.unmount()); }
});
