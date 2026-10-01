import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCopilotOverlay } from './copilotOverlay';
import { copilotDefaults, type CopilotMark, type CopilotPresentation, type VisualCopilot } from './visualCopilot';
import type { NativeCopilotFrame, NativeCopilotUpdate } from '../desktop/copilot';

const host = vi.hoisted(() => ({ native: true, overlays: true, session: undefined as string | undefined,
  state: 'visible' as 'visible' | 'hidden' | 'unavailable', clear: vi.fn(), sync: vi.fn(), upload: vi.fn(), draw: vi.fn(), cached: new Set<string>() }));
vi.mock('../desktop/capabilities', () => ({ getDesktopCapabilities: () => ({ nativeOverlays: { state: host.native && host.overlays ? 'experimental' : 'unavailable' } }) }));
vi.mock('../desktop/copilot', () => ({ clearNativeCopilot: host.clear, syncNativeCopilot: host.sync, uploadNativeCopilotFrame: host.upload }));
vi.mock('./nativeCaptureRegistry', () => ({ nativeScreenSessionForTrack: () => host.session }));
vi.mock('./copilotArtwork', () => ({ drawCopilotArtwork: host.draw }));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const artwork = () => ({ width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const stops: (() => void)[] = [];
let settings = { ...copilotDefaults, enabled: true };
class Controller {
  source = {} as MediaStreamTrack | null;
  state: { marks: CopilotMark[]; localPresentation: CopilotPresentation } = { marks: [], localPresentation: { mode: 'in-app', state: 'ready' } };
  listeners = new Set<() => void>();
  getSource = () => this.source;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setPresentation = vi.fn((presentation: CopilotPresentation) => { this.state = { ...this.state, localPresentation: presentation }; this.notify(); });
  notify() { for (const listener of this.listeners) listener(); }
  marks(marks: CopilotMark[]) { this.state = { ...this.state, marks }; this.notify(); }
  dismiss(id: string) { this.marks(this.state.marks.filter(mark => mark.id !== id)); }
}
const mark = (patch: Partial<CopilotMark> = {}): CopilotMark => ({ id: 'mark-1', peerId: 'viewer', kind: 'ping', x: .2, y: .3, expires: performance.now() + 2000, ...patch });
function mount(controller: Controller, status = vi.fn()) {
  const stop = attachCopilotOverlay(controller as unknown as VisualCopilot, () => ({ viewer: 'Viewer' }), status);
  stops.push(stop); return { stop, status };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  host.native = true; host.overlays = true; host.session = undefined; host.state = 'visible'; host.cached.clear();
  settings = { ...copilotDefaults, enabled: true };
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(settings) });
  host.clear.mockImplementation(async () => { host.cached.clear(); });
  host.upload.mockImplementation(async (frame: NativeCopilotFrame) => { host.cached.add(frame.markId); });
  host.sync.mockImplementation(async (update: NativeCopilotUpdate) => {
    const keep = new Set(update.marks.map(mark => mark.markId));
    for (const id of host.cached) if (!keep.has(id)) host.cached.delete(id);
    return { state: host.state, missing: update.marks.filter(mark => !host.cached.has(mark.markId)).map(mark => mark.markId) };
  });
  host.draw.mockImplementation(async () => artwork());
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop(); await flush();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('external copilot availability', () => {
  it.each(['browser', 'unsupported-platform', 'old-host', 'browser-capture', 'native-capture'])('explains %s without idle polling', async kind => {
    host.native = kind !== 'browser';
    host.overlays = kind !== 'unsupported-platform';
    host.session = kind === 'native-capture' ? 'session' : undefined;
    if (kind === 'old-host') { host.session = 'session'; host.sync.mockRejectedValue(new Error('Old host command unavailable')); }
    const controller = new Controller(); const { status } = mount(controller);
    await flush();
    const expected = kind === 'old-host' ? 'External overlay unavailable' : kind === 'native-capture' ? 'Native overlay ready' : 'inside BetterComms';
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining(expected));
    const calls = [host.clear.mock.calls.length, host.sync.mock.calls.length, host.upload.mock.calls.length];
    await vi.advanceTimersByTimeAsync(5000);
    expect([host.clear.mock.calls.length, host.sync.mock.calls.length, host.upload.mock.calls.length]).toEqual(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('native artwork and position lifecycle', () => {
  it('caches artwork during laser movement and sends only bounded position updates', async () => {
    host.session = 'session';
    const controller = new Controller(); const first = mark({ id: 'laser-viewer', laser: true, trail: [{ x: .1, y: .2, at: performance.now() }] });
    controller.marks([first]); mount(controller); await flush();
    expect(host.draw).toHaveBeenCalledTimes(1); expect(host.upload).toHaveBeenCalledTimes(1);
    const initialSyncs = host.sync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(125);
    controller.marks([{ ...first, x: .8, y: .7, expires: performance.now() + 2000, trail: [{ x: .6, y: .5, at: performance.now() }] }]); await flush();
    expect(host.draw).toHaveBeenCalledTimes(1); expect(host.upload).toHaveBeenCalledTimes(1);
    expect(host.sync).toHaveBeenCalledTimes(initialSyncs + 1);
    expect(host.sync.mock.calls.at(-1)![0]).toMatchObject({ sessionId: 'session', marks: [{ markId: 'laser-viewer', x: .8, y: .7, trail: [{ x: .6, y: .5, ageMs: 0 }] }] });
    expect(host.clear).toHaveBeenCalledTimes(1);
  });

  it('uses integer trail ages at fractional performance clock values', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000.25);
    host.session = 'session'; const controller = new Controller();
    controller.marks([mark({ laser: true, expires: 2000, trail: [{ x: .2, y: .3, at: 900.1 }, { x: .1, y: .1, at: 500 }] })]);
    mount(controller); await flush();
    expect(host.sync.mock.calls.at(-1)![0].marks[0].trail).toEqual([{ x: .2, y: .3, ageMs: 101 }]);
  });

  it('keeps revisions increasing when signal duration shrinks during laser movement', async () => {
    host.session = 'session'; const controller = new Controller();
    const first = mark({ id: 'laser-viewer', laser: true, expires: performance.now() + 4000 });
    controller.marks([first]); mount(controller); await flush();
    const previous = host.sync.mock.calls.at(-1)![0].marks[0];
    await vi.advanceTimersByTimeAsync(125);
    controller.marks([{ ...first, x: .8, expires: performance.now() + 1000 }]); await flush();
    const next = host.sync.mock.calls.at(-1)![0].marks[0];
    expect(next.remainingMs).toBe(1000); expect(next.revision).toBeGreaterThan(previous.revision);
    expect(host.upload).toHaveBeenCalledTimes(1);
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'visible' });
  });

  it('reuploads retained artwork when the native cache explicitly reports it missing', async () => {
    host.session = 'session'; const controller = new Controller(); controller.marks([mark()]); mount(controller); await flush();
    host.cached.clear();
    await vi.advanceTimersByTimeAsync(750);
    expect(host.draw).toHaveBeenCalledTimes(1); expect(host.upload).toHaveBeenCalledTimes(2);
  });

  it('publishes actual native hidden and visible states while preserving artwork', async () => {
    host.session = 'session'; host.state = 'hidden';
    const controller = new Controller(); controller.marks([mark()]); const { status } = mount(controller); await flush();
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'hidden' });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('hidden while the shared application is not in front'));
    host.state = 'visible'; await vi.advanceTimersByTimeAsync(750);
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'visible' });
    expect(host.draw).toHaveBeenCalledTimes(1); expect(host.upload).toHaveBeenCalledTimes(1);
  });

  it('cancels revoked artwork before it can be uploaded and returns to idle', async () => {
    host.session = 'session'; const pending = deferred<ReturnType<typeof artwork>>(); host.draw.mockReturnValueOnce(pending.promise);
    const controller = new Controller(); controller.marks([mark({ kind: 'snapshot', image: 'fixture' })]); mount(controller); await flush();
    expect(host.draw).toHaveBeenCalledTimes(1);
    controller.marks([]); pending.resolve(artwork()); await flush();
    expect(host.upload).not.toHaveBeenCalled();
    expect(host.sync.mock.calls.at(-1)![0].marks).toEqual([]);
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'ready' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes a revoked mark immediately after an in-flight upload finishes', async () => {
    host.session = 'session'; const pending = deferred<void>();
    host.upload.mockImplementationOnce(async (frame: NativeCopilotFrame) => { await pending.promise; host.cached.add(frame.markId); });
    const controller = new Controller(); controller.marks([mark()]); mount(controller); await flush();
    expect(host.upload).toHaveBeenCalledTimes(1);
    controller.marks([]); pending.resolve(); await flush();
    expect(host.cached.size).toBe(0); expect(host.sync.mock.calls.at(-1)![0].marks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up canceled async artwork and never uploads its old frame', async () => {
    host.session = 'session'; const pending = deferred<ReturnType<typeof artwork>>(); host.draw.mockReturnValueOnce(pending.promise);
    const controller = new Controller(); controller.marks([mark()]); const { stop } = mount(controller); await flush();
    stop(); pending.resolve(artwork()); await flush();
    expect(host.upload).not.toHaveBeenCalled(); expect(host.cached.size).toBe(0);
    expect(controller.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a canceled renderer after an in-flight upload without publishing late status', async () => {
    host.session = 'session'; const pending = deferred<void>();
    host.upload.mockImplementationOnce(async (frame: NativeCopilotFrame) => { await pending.promise; host.cached.add(frame.markId); });
    const controller = new Controller(); controller.marks([mark()]); const { stop, status } = mount(controller); await flush();
    expect(host.upload).toHaveBeenCalledTimes(1);
    stop(); pending.resolve(); await flush();
    expect(host.cached.size).toBe(0); expect(status).not.toHaveBeenCalled();
    expect(controller.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an old source after async upload before processing the replacement source', async () => {
    host.session = 'old-session'; const pending = deferred<void>();
    host.upload.mockImplementationOnce(async (frame: NativeCopilotFrame) => { await pending.promise; host.cached.add(frame.markId); });
    const controller = new Controller(); controller.marks([mark()]); mount(controller); await flush();
    host.session = 'new-session'; controller.source = {} as MediaStreamTrack; controller.marks([]);
    pending.resolve(); await flush();
    expect(host.cached.size).toBe(0); expect(host.clear).toHaveBeenCalledTimes(2);
    expect(host.sync.mock.calls.at(-1)![0]).toEqual({ sessionId: 'new-session', marks: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prevents a replaced renderer from clearing or publishing over its new owner', async () => {
    host.session = 'session'; const pending = deferred<ReturnType<typeof artwork>>(); host.draw.mockReturnValueOnce(pending.promise);
    const first = new Controller(); first.marks([mark({ id: 'old-mark' })]); const previous = mount(first); await flush();
    previous.stop();
    const second = new Controller(); second.marks([mark({ id: 'new-mark' })]); const current = mount(second); await flush();
    const clears = host.clear.mock.calls.length;
    pending.resolve(artwork()); await flush();
    expect(host.clear).toHaveBeenCalledTimes(clears);
    expect(host.cached).toEqual(new Set(['new-mark']));
    expect(current.status).toHaveBeenLastCalledWith(expect.stringContaining('visible over the shared source'));
    expect(previous.status).not.toHaveBeenCalled();
  });

  it('serializes owner replacement behind an in-flight upload before installing new artwork', async () => {
    host.session = 'session'; const pending = deferred<void>();
    host.upload.mockImplementationOnce(async (frame: NativeCopilotFrame) => { await pending.promise; host.cached.add(frame.markId); });
    const first = new Controller(); first.marks([mark({ id: 'old-mark' })]); const previous = mount(first); await flush();
    previous.stop();
    const second = new Controller(); second.marks([mark({ id: 'new-mark' })]); const current = mount(second); await flush();
    expect(host.upload).toHaveBeenCalledTimes(1);
    pending.resolve(); await flush();
    expect(host.cached).toEqual(new Set(['new-mark']));
    expect(host.upload).toHaveBeenCalledTimes(2); expect(previous.status).not.toHaveBeenCalled();
    expect(current.status).toHaveBeenLastCalledWith(expect.stringContaining('visible over the shared source'));
  });

  it('discards unreadable artwork without disabling other indications', async () => {
    host.session = 'session'; host.draw.mockImplementation(async (mark: CopilotMark) => {
      if (mark.id === 'bad-card') throw new Error('Corrupt captured frame');
      return artwork();
    });
    const controller = new Controller();
    controller.marks([mark({ id: 'bad-card', kind: 'snapshot', image: 'corrupt' }), mark({ id: 'good-point' })]);
    const { status } = mount(controller); await flush();
    expect(controller.state.marks.map(mark => mark.id)).toEqual(['good-point']);
    expect(host.cached).toEqual(new Set(['good-point']));
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'visible' });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('unreadable indication was discarded'));
  });

  it('bounds finite lifetimes, renews manual leases, and stops polling after dismissal', async () => {
    host.session = 'session'; const controller = new Controller();
    controller.marks([mark({ expires: performance.now() + 1000 })]); mount(controller); await flush();
    const revision = host.sync.mock.calls.at(-1)![0].marks[0].revision;
    await vi.advanceTimersByTimeAsync(750);
    expect(host.sync.mock.calls.at(-1)![0].marks[0]).toMatchObject({ remainingMs: 250, revision });
    controller.marks([mark({ id: 'manual-card', kind: 'snapshot', image: 'fixture', expires: Infinity })]); await flush();
    expect(host.sync.mock.calls.at(-1)![0].marks[0]).toMatchObject({ markId: 'manual-card', remainingMs: 60_000, revision: 1 });
    const uploads = host.upload.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_750);
    expect(host.sync.mock.calls.at(-1)![0].marks[0]).toMatchObject({ markId: 'manual-card', remainingMs: 60_000, revision: 1 });
    expect(host.upload).toHaveBeenCalledTimes(uploads);
    controller.marks([]); await flush(); expect(vi.getTimerCount()).toBe(0);
    const calls = host.sync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(host.sync).toHaveBeenCalledTimes(calls);
  });

  it('recovers a temporarily unavailable source while indications remain active', async () => {
    host.session = 'session'; host.state = 'unavailable';
    const controller = new Controller(); controller.marks([mark()]); mount(controller); await flush();
    expect(controller.state.localPresentation).toEqual({ mode: 'in-app', state: 'unavailable' });
    expect(host.upload).not.toHaveBeenCalled();
    host.state = 'visible'; await vi.advanceTimersByTimeAsync(750);
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'visible' });
    expect(host.draw).toHaveBeenCalledTimes(1); expect(host.upload).toHaveBeenCalledTimes(1);
    controller.marks([]); await flush(); expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back after a broken native API and retries only when the source session changes', async () => {
    host.session = 'session'; host.sync.mockRejectedValue(new Error('Broken native API'));
    const controller = new Controller(); controller.marks([mark()]); mount(controller); await flush();
    expect(controller.state.localPresentation).toEqual({ mode: 'in-app', state: 'unavailable' });
    expect(host.cached.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    const calls = host.sync.mock.calls.length;
    controller.marks([mark({ x: .8 })]); await flush(); expect(host.sync).toHaveBeenCalledTimes(calls);
    host.sync.mockResolvedValue({ state: 'visible', missing: [] }); host.session = 'replacement'; controller.source = {} as MediaStreamTrack; controller.notify(); await flush();
    expect(controller.state.localPresentation).toEqual({ mode: 'native', state: 'visible' });
  });
});
