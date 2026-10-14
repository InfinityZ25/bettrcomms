import { describe, expect, it, vi } from 'vitest';
import { createWatchViewing } from './watchViewing';

function deferred() {
  let resolve!: () => void;
  let reject!: (failure: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('watch viewing ownership', () => {
  it('does not write when StrictMode closes a mount that never joined', async () => {
    const write = vi.fn(async () => {});
    const viewing = createWatchViewing(new AbortController().signal, write);
    viewing.close();
    viewing.close();
    expect(await viewing.renew()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('releases an explicit join once and stops writes after close', async () => {
    const controller = new AbortController();
    const write = vi.fn(async (_present: boolean, _signal?: AbortSignal) => {});
    const viewing = createWatchViewing(controller.signal, write);
    expect(await viewing.set(true)).toBe(true);
    viewing.close();
    viewing.close();
    expect(await viewing.set(true)).toBe(false);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[0]).toEqual([true, controller.signal]);
    expect(write.mock.calls[1][0]).toBe(false);
    expect(write.mock.calls[1][1]).toBeInstanceOf(AbortSignal);
    expect(write.mock.calls[1][1]).not.toBe(controller.signal);
    expect(viewing.wantsPresence()).toBe(false);
  });

  it('does not leave again after the user already left successfully', async () => {
    const write = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const viewing = createWatchViewing(signal, write);
    await viewing.set(true);
    await viewing.set(false);
    viewing.close();
    expect(write.mock.calls).toEqual([
      [true, signal],
      [false, signal],
    ]);
  });

  it('releases a late join ACK using the old device, preserving a new mount', async () => {
    const ack = deferred();
    const oldPresent = new Set<string>();
    const oldWrite = vi.fn(async (present: boolean) => {
      if (present) await ack.promise;
      if (present) oldPresent.add('old');
      else oldPresent.delete('old');
    });
    const oldViewing = createWatchViewing(
      new AbortController().signal,
      oldWrite,
    );
    const joining = oldViewing.set(true);
    await Promise.resolve();
    oldViewing.close();
    const nextPresent = new Set<string>();
    const nextWrite = vi.fn(async (present: boolean) => {
      if (present) nextPresent.add('next');
      else nextPresent.delete('next');
    });
    const nextViewing = createWatchViewing(
      new AbortController().signal,
      nextWrite,
    );
    await nextViewing.set(true);
    ack.resolve();
    expect(await joining).toBe(false);
    await vi.waitFor(() => expect(oldWrite).toHaveBeenCalledTimes(2));
    expect(oldPresent.size).toBe(0);
    expect(nextPresent.has('next')).toBe(true);
    expect(nextWrite).toHaveBeenCalledTimes(1);
    nextViewing.close();
  });

  it('attempts release for an aborted explicit join without claiming an ACK', async () => {
    const controller = new AbortController();
    const ack = deferred();
    const write = vi.fn((present: boolean, _signal?: AbortSignal) =>
      present ? ack.promise : Promise.resolve(),
    );
    const viewing = createWatchViewing(controller.signal, write);
    const joining = viewing.set(true);
    await Promise.resolve();
    controller.abort();
    viewing.close();
    const failure = new DOMException('Aborted', 'AbortError');
    ack.reject(failure);
    await expect(joining).rejects.toBe(failure);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1][0]).toBe(false);
    expect(write.mock.calls[1][1]?.aborted).toBe(false);
    expect(viewing.wantsPresence()).toBe(false);
  });

  it('orders Leave after a delayed renewal and blocks further renewals immediately', async () => {
    const ack = deferred();
    const writes: boolean[] = [];
    let present = false;
    const write = vi.fn(async (next: boolean) => {
      writes.push(next);
      if (next && writes.length === 2) await ack.promise;
      present = next;
    });
    const viewing = createWatchViewing(new AbortController().signal, write);
    await viewing.set(true);
    const renewing = viewing.renew();
    await Promise.resolve();
    const leaving = viewing.set(false);
    expect(viewing.wantsPresence()).toBe(false);
    expect(await viewing.renew()).toBe(false);
    expect(writes).toEqual([true, true]);
    ack.resolve();
    expect(await renewing).toBe(false);
    expect(await leaving).toBe(true);
    expect(writes).toEqual([true, true, false]);
    expect(present).toBe(false);
    viewing.close();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('does not accumulate heartbeats while one renewal is pending', async () => {
    const ack = deferred();
    let calls = 0;
    const write = vi.fn(async () => {
      if (++calls === 2) await ack.promise;
    });
    const viewing = createWatchViewing(new AbortController().signal, write);
    expect(await viewing.renew()).toBe(false);
    await viewing.set(true);
    const renewing = viewing.renew();
    await Promise.resolve();
    expect(await viewing.renew()).toBe(false);
    expect(await viewing.renew()).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    ack.resolve();
    expect(await renewing).toBe(true);
    await viewing.set(false);
  });

  it('does not resume renewals after a failed Leave and can retry it', async () => {
    let calls = 0;
    const write = vi.fn(async (present: boolean) => {
      if (++calls === 2 && !present) throw new Error('Offline');
    });
    const viewing = createWatchViewing(new AbortController().signal, write);
    await viewing.set(true);
    await expect(viewing.set(false)).rejects.toThrow('Offline');
    expect(await viewing.renew()).toBe(false);
    expect(await viewing.set(false)).toBe(true);
    viewing.close();
    expect(write).toHaveBeenCalledTimes(3);
  });
});
