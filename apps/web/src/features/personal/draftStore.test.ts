import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '@/api';
import {
  draftReplyToId,
  draftScope,
  draftsSnapshot,
  editTextDraft,
  focusTextDraft,
  loadTextDraft,
  receiveTextDraft,
  refreshDrafts,
  resolveDraftConflict,
  sentTextDraft,
  setDraftSync,
  startDraftSession,
  submittedDraft,
} from './draftStore';
import type { TextDraft } from './api';

vi.mock('@/api', async (original) => ({
  ...(await original<typeof import('@/api')>()),
  api: vi.fn(),
}));
const room = '11111111-1111-4111-8111-111111111111';
const root = '22222222-2222-4222-8222-222222222222';
let values: Map<string, string>;
let server: Map<string, TextDraft>;
let setting: { enabled: boolean; version: number };
let stop: (() => void) | undefined;
let offline: boolean;
const record = (body: string, version = 1, threadRoot?: string): TextDraft => ({
  room_id: room,
  thread_root_id: threadRoot,
  body,
  version,
  updated_at: '2026-10-11T12:00:00Z',
});
const entry = (threadRoot?: string) =>
  draftsSnapshot().entries[draftScope(room, threadRoot)];
const puts = () =>
  vi
    .mocked(api)
    .mock.calls.filter(
      ([path, , method]) => path.startsWith('/rooms/') && method === 'PUT',
    );
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  values = new Map();
  server = new Map();
  setting = { enabled: true, version: 0 };
  offline = false;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.mocked(api).mockImplementation(async (path, body, method) => {
    if (offline) throw new Error('Offline');
    if (path === '/me/draft-sync') {
      if (method === 'PUT')
        setting = {
          enabled: (body as { enabled: boolean }).enabled,
          version: setting.version + 1,
        };
      return { ...setting };
    }
    if (path.startsWith('/me/drafts')) return { drafts: [...server.values()] };
    const url = new URL(path, 'http://localhost');
    const thread = url.searchParams.get('thread_root_id') ?? undefined;
    const scope = draftScope(room, thread);
    const previous = server.get(scope) ?? {
      room_id: room,
      thread_root_id: thread,
      body: '',
      version: 0,
    };
    if (method !== 'PUT') return { ...previous };
    const input = body as {
      expected_version: number;
      body: string;
      reply_to_id?: string;
      mutation_id: string;
    };
    if (input.mutation_id === previous.mutation_id) return previous;
    if (input.expected_version !== previous.version)
      throw new ApiRequestError('Changed on another device', 409);
    const next = {
      ...record(input.body, previous.version + 1, thread),
      reply_to_id: input.reply_to_id,
      mutation_id: input.mutation_id,
    };
    server.set(scope, next);
    return next;
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start() {
  stop = startDraftSession('alice');
  await vi.advanceTimersByTimeAsync(0);
}

describe('automatic account text drafts', () => {
  it('accepts a first empty scope without a timestamp and imports only this account text', async () => {
    values.set(
      `bettercomms:draft:alice:${room}`,
      JSON.stringify({
        body: 'Continue from this PC',
        attachments: [{ filename: 'private.mp4', uploadId: 'private-upload' }],
        nonce: 'send-private',
        fingerprint: 'private',
      }),
    );
    values.set(
      `bettercomms:draft:bob:${room}`,
      JSON.stringify({ body: 'Other account secret' }),
    );
    await start();
    await vi.advanceTimersByTimeAsync(500);
    expect(draftsSnapshot()).toMatchObject({ enabled: true, ready: true });
    expect(entry()).toMatchObject({
      body: 'Continue from this PC',
      version: 1,
      dirty: false,
      ready: true,
    });
    expect(puts()).toHaveLength(1);
    expect(puts()[0][1]).toEqual({
      body: 'Continue from this PC',
      reply_to_id: undefined,
      expected_version: 0,
      mutation_id: expect.any(String),
    });
    expect(JSON.stringify(puts())).not.toContain('private.mp4');
    expect(JSON.stringify(puts())).not.toContain('Other account');
  });
  it('keeps both initial divergent texts without automatically overwriting cloud content', async () => {
    values.set(
      `bettercomms:draft:alice:${room}`,
      JSON.stringify({ body: 'PC copy' }),
    );
    server.set(room, record('Phone copy', 4));
    await start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(entry()).toMatchObject({
      body: 'PC copy',
      conflict: { body: 'Phone copy', version: 4 },
    });
    expect(puts()).toHaveLength(0);
    resolveDraftConflict(room, 'local');
    await vi.advanceTimersByTimeAsync(500);
    expect(server.get(room)).toMatchObject({ body: 'PC copy', version: 5 });
  });
  it('preserves edits typed while a write is in flight and writes them against its acknowledged version', async () => {
    await start();
    await loadTextDraft(room);
    let finish!: (value: TextDraft) => void;
    const normal = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((path, body, method, signal) =>
      method === 'PUT' && path.startsWith('/rooms/')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : normal(path, body, method, signal),
    );
    editTextDraft(room, 'First');
    await vi.advanceTimersByTimeAsync(500);
    const mutation = puts()[0][1] as { mutation_id: string };
    editTextDraft(room, 'First plus more');
    finish({ ...record('First', 1), mutation_id: mutation.mutation_id });
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toMatchObject({
      body: 'First plus more',
      version: 1,
      dirty: true,
    });
    vi.mocked(api).mockImplementation(normal);
    server.set(room, record('First', 1));
    await vi.advanceTimersByTimeAsync(500);
    expect(entry()).toMatchObject({
      body: 'First plus more',
      version: 2,
      dirty: false,
    });
  });
  it('keeps a clean but actively focused draft when another device changes it', async () => {
    server.set(room, record('Existing', 1));
    await start();
    focusTextDraft(room, true);
    receiveTextDraft(record('Phone changed it', 2));
    expect(entry()).toMatchObject({
      body: 'Existing',
      conflict: { body: 'Phone changed it' },
    });
    resolveDraftConflict(room, 'remote');
    expect(entry()).toMatchObject({
      body: 'Phone changed it',
      conflict: undefined,
      dirty: false,
    });
  });
  it('preserves offline changes and exposes a conflict after reconnect rather than losing either text', async () => {
    server.set(room, record('Original', 1));
    await start();
    offline = true;
    editTextDraft(room, 'Offline edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(entry()).toMatchObject({
      body: 'Offline edit',
      dirty: true,
      error: 'Offline',
    });
    server.set(room, record('Phone edit', 2));
    offline = false;
    await refreshDrafts();
    expect(entry()).toMatchObject({
      body: 'Offline edit',
      conflict: { body: 'Phone edit' },
    });
  });
  it('does not clear a newer remote draft after sending an older submitted revision', async () => {
    server.set(room, record('Send this', 1));
    await start();
    const submitted = await submittedDraft(room);
    expect(submitted?.draft_version).toBe(1);
    receiveTextDraft(record('New text on phone', 2));
    sentTextDraft(room, 'Send this', undefined, submitted?.draft_version);
    expect(entry()).toMatchObject({ body: 'New text on phone', version: 2 });
  });
  it('keeps thread/reply scopes independent and preserves 4000 emoji without broken UTF-16', async () => {
    await start();
    await loadTextDraft(room, root);
    editTextDraft(room, '😀'.repeat(4000), root, root);
    await vi.advanceTimersByTimeAsync(500);
    expect(entry(root).body).toHaveLength(8000);
    expect([...entry(root).body]).toHaveLength(4000);
    expect(server.get(draftScope(room, root))).toMatchObject({
      reply_to_id: root,
      thread_root_id: root,
    });
    expect(entry()).toBeUndefined();
  });
  it('preserves a cloud reply while its quoted message is still loading and respects an explicit cancellation', async () => {
    server.set(room, {
      ...record('Continue this reply', 3),
      reply_to_id: root,
    });
    await start();
    let finishQuote!: (value: unknown) => void;
    const normal = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((path, body, method, signal) =>
      path === `/rooms/${room}/messages/${root}`
        ? new Promise((resolve) => {
            finishQuote = resolve;
          })
        : normal(path, body, method, signal),
    );
    let hydratedReplyId: string | undefined;
    const hydration = api<{ message: { id: string } }>(
      `/rooms/${room}/messages/${root}`,
    ).then((value) => {
      hydratedReplyId = value.message.id;
    });
    editTextDraft(
      room,
      'Continue this reply while preview loads',
      draftReplyToId(room, hydratedReplyId),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(server.get(room)).toMatchObject({
      body: 'Continue this reply while preview loads',
      reply_to_id: root,
      version: 4,
    });
    expect((await submittedDraft(room))?.draft_version).toBe(4);
    expect(draftReplyToId(room, hydratedReplyId)).toBe(root);
    editTextDraft(room, entry().body, undefined);
    await vi.advanceTimersByTimeAsync(500);
    finishQuote({ message: { id: root } });
    await hydration;
    expect(entry()).toMatchObject({ replyToId: undefined });
    // Hydration applies only if the currently owned draft still refers to it.
    expect(entry().replyToId === hydratedReplyId).toBe(false);
    expect(draftReplyToId(room)).toBeUndefined();
    expect(draftReplyToId(room, hydratedReplyId)).toBeUndefined();
  });
  it('disabled account sync retains local text and leaves remote content untouched', async () => {
    server.set(room, record('Cloud retained', 1));
    await start();
    await setDraftSync(false);
    editTextDraft(room, 'Only this device');
    await vi.advanceTimersByTimeAsync(1000);
    expect(entry().body).toBe('Only this device');
    expect(server.get(room)?.body).toBe('Cloud retained');
    expect(puts()).toHaveLength(0);
  });
  it('disabling sync aborts an in-flight write and ignores its delayed response', async () => {
    await start();
    await loadTextDraft(room);
    let finish!: (value: TextDraft) => void;
    let writeSignal: AbortSignal | undefined;
    const normal = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((path, body, method, signal) =>
      method === 'PUT' && path.startsWith('/rooms/')
        ? new Promise((resolve) => {
            finish = resolve;
            writeSignal = signal;
          })
        : normal(path, body, method, signal),
    );
    editTextDraft(room, 'Keep locally');
    await vi.advanceTimersByTimeAsync(500);
    await setDraftSync(false);
    expect(writeSignal?.aborted).toBe(true);
    finish(record('Unexpected delayed copy', 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toMatchObject({ body: 'Keep locally', writing: false });
    expect(draftsSnapshot().enabled).toBe(false);
  });
  it('clears memory across accounts and ignores an old response or stale cleanup', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const staleStop = startDraftSession('alice');
    stop = startDraftSession('bob');
    staleStop();
    finish({ enabled: true, version: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(draftsSnapshot().userId).toBe('bob');
    expect(draftsSnapshot().entries).toEqual({});
  });
});
