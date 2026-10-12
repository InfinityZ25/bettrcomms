import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const existing = {
    navigate: vi.fn(),
    postMessage: vi.fn(),
    focus: vi.fn().mockResolvedValue(undefined),
  };
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  runInNewContext(
    readFileSync(
      new URL('../../../public/push-sw.js', import.meta.url),
      'utf8',
    ),
    {
      URL,
      self: {
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          handlers.set(name, handler),
        location: { origin: 'https://app.bettrcomms.com' },
        registration: { showNotification },
        clients: {
          matchAll: vi.fn().mockResolvedValue([existing]),
          openWindow,
        },
      },
    },
  );
  async function dispatch(type: string, fields: Record<string, unknown>) {
    let work: Promise<unknown> | undefined;
    handlers.get(type)?.({
      ...fields,
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
    });
    await work;
  }
  return { dispatch, existing, showNotification, openWindow };
}
describe('push reminders and existing call preservation', () => {
  it('shows a generic summary with its shared per-device tag and no source message content', async () => {
    const scope = worker();
    await scope.dispatch('push', {
      data: {
        json: () => ({
          kind: 'reminder-summary',
          tag: 'bettercomms-reminders:device',
          count: 2,
          body: 'Sensitive source text',
        }),
      },
    });
    expect(scope.showNotification).toHaveBeenCalledWith(
      'BetterComms reminders',
      {
        body: 'You have reminders to review.',
        tag: 'bettercomms-reminders:device',
        data: { personalInbox: 'reminders' },
      },
    );
  });
  it('focuses an existing window and posts the inbox destination without navigating away from a call', async () => {
    const scope = worker();
    await scope.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { personalInbox: 'reminders' } },
    });
    expect(scope.existing.postMessage).toHaveBeenCalledWith({
      type: 'bc-notification-click',
      roomId: undefined,
      personalInbox: 'reminders',
    });
    expect(scope.existing.focus).toHaveBeenCalledOnce();
    expect(scope.existing.navigate).not.toHaveBeenCalled();
    expect(scope.openWindow).not.toHaveBeenCalled();
  });
  it('preserves ordinary message tags and directs their clicks through the same in-app navigation', async () => {
    const scope = worker();
    await scope.dispatch('push', {
      data: { json: () => ({ room_id: 'room' }) },
    });
    expect(scope.showNotification).toHaveBeenCalledWith(
      'BetterComms',
      expect.objectContaining({
        tag: 'message:room',
        data: { roomId: 'room' },
      }),
    );
    await scope.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { roomId: 'room' } },
    });
    expect(scope.existing.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bc-notification-click',
        roomId: 'room',
      }),
    );
    expect(scope.existing.navigate).not.toHaveBeenCalled();
  });
});
