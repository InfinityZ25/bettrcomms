type ViewingWrite = (
  present: boolean,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Serialize this mount's viewing writes so renewals cannot overtake Leave. */
export function createWatchViewing(signal: AbortSignal, write: ViewingWrite) {
  let closed = false;
  let desired = false;
  let revision = 0;
  let requested = false;
  let pending = 0;
  let tail = Promise.resolve();
  function schedule(present: boolean, expected: number, cleanup = false) {
    pending++;
    const result = tail.then(async () => {
      if (!cleanup && (closed || signal.aborted || expected !== revision))
        return false;
      if (present) requested = true;
      // Release survives mount cancellation, but cannot wait indefinitely.
      await write(present, cleanup ? AbortSignal.timeout(10000) : signal);
      if (!present) requested = false;
      return !closed && !signal.aborted && expected === revision;
    });
    tail = result.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return result;
  }
  return {
    signal,
    wantsPresence: () => desired && !closed && !signal.aborted,
    set(present: boolean) {
      if (closed || signal.aborted) return Promise.resolve(false);
      desired = present;
      return schedule(present, ++revision);
    },
    renew() {
      if (closed || signal.aborted || !desired || pending)
        return Promise.resolve(false);
      return schedule(true, revision);
    },
    close() {
      if (closed) return;
      closed = true;
      desired = false;
      revision++;
      // An aborted join has an uncertain server outcome; try the same device.
      if (requested) void schedule(false, revision, true).catch(() => {});
    },
  };
}
