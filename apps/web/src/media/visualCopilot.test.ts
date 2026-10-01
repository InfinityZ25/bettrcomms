import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualCopilot, copilotDefaults, isCopilotImage, videoPoint } from './visualCopilot';

class Channel {
  readyState = 'open'; bufferedAmount = 0;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null; bufferedAmountLowThreshold = 0;
  sent: Record<string, unknown>[] = []; queued: string[] = []; hold = false; legacy = false;
  remote?: Channel;
  send(data: string) {
    const message = JSON.parse(data);
    if (this.legacy && message.type === 'hello') delete message.laser;
    data = JSON.stringify(message); this.sent.push(message);
    if (this.hold) this.queued.push(data);
    else queueMicrotask(() => this.remote?.onmessage?.({ data }));
  }
  deliver(index = 0) { const data = this.queued.splice(index, 1)[0]; if (data) queueMicrotask(() => this.remote?.onmessage?.({ data })); }
  unblock() { this.bufferedAmount = 0; this.onbufferedamountlow?.(); }
  close() { this.readyState = 'closed'; }
}
let settings = { ...copilotDefaults, enabled: true };
beforeEach(() => { settings = { ...copilotDefaults, enabled: true }; vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(settings) }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function source() { const track = new EventTarget(); return Object.assign(track, { readyState: 'live', id: crypto.randomUUID() }) as unknown as MediaStreamTrack; }
const image = () => 'data:image/jpeg;base64,' + btoa(String.fromCharCode(255, 216, 255, 192, 0, 11, 8, 0, 100, 1, 64, 1, 1, 0, 0));
async function pair(options: { legacy?: boolean; noLaser?: boolean } = {}) {
  const a = new VisualCopilot(), b = new VisualCopilot();
  const ca = new Channel(), cb = new Channel(), la = new Channel(), lb = new Channel();
  ca.remote = cb; cb.remote = ca; la.remote = lb; lb.remote = la; ca.legacy = !!options.legacy;
  const create = (control: Channel, laser: Channel) => (_name: string, settings: RTCDataChannelInit) => {
    if (settings.id === 14 && options.noLaser) throw new Error('Unsupported channel');
    if (settings.id === 14) { expect(settings).toMatchObject({ ordered: false, maxRetransmits: 0 }); return laser; }
    expect(settings).toMatchObject({ id: 13, ordered: true }); return control;
  };
  a.attach('b', { createDataChannel: create(ca, la) } as unknown as RTCPeerConnection);
  b.attach('a', { createDataChannel: create(cb, lb) } as unknown as RTCPeerConnection);
  ca.onopen?.(); cb.onopen?.(); await flush();
  a.setSource(source());
  return { a, b, ca, cb, la, lb, close: () => { a.dispose(); b.dispose(); } };
}
describe('visual collaboration permissions and lifecycle', () => {
  it('replaces laser positions, drops buffered movement, expires and revokes them', async () => {
    vi.useFakeTimers();
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      p.b.mark('a', 'ping', .2, .3, undefined, 0, true); await flush();
      expect(p.a.getSnapshot().marks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(125);
      p.b.mark('a', 'ping', .7, .8, undefined, 0, true); await flush();
      expect(p.a.getSnapshot().marks).toHaveLength(1);
      expect(p.a.getSnapshot().marks[0]).toMatchObject({ laser: true, x: .7 });
      p.lb.bufferedAmount = 1;
      await vi.advanceTimersByTimeAsync(125);
      p.b.mark('a', 'ping', .9, .8, undefined, 0, true); await flush();
      expect(p.a.getSnapshot().marks[0].x).toBe(.7);
      await vi.advanceTimersByTimeAsync(2000);
      expect(p.a.getSnapshot().marks).toHaveLength(0);
      p.lb.bufferedAmount = 0;
      p.b.mark('a', 'ping', .4, .5, undefined, 0, true); await flush();
      p.a.pause(); await flush();
      expect(p.a.getSnapshot().marks).toHaveLength(0);
      expect(() => p.b.mark('a', 'ping', .4, .5, undefined, 0, true)).toThrow(/not allowed/);
    } finally { p.close(); }
  });
  it('requires explicit permission and acknowledges an authorized signal', async () => {
    const p = await pair();
    try {
      expect(p.a.getSnapshot().grants).toEqual({});
      expect(() => p.b.mark('a', 'ping', .2, .3)).toThrow(/not allowed/);
      p.a.grant('b', true, false); await flush();
      p.b.mark('a', 'ping', .2, .3); await flush();
      expect(p.a.getSnapshot().marks[0]).toMatchObject({ peerId: 'b', kind: 'ping', x: .2, y: .3 });
      expect(p.b.getSnapshot().status).toBe('Received by the sharer.');
      expect(() => p.b.mark('a', 'snapshot', .2, .3)).toThrow(/not allowed/);
    } finally { p.close(); }
  });
  it('invalidates old permissions and marks on source replacement and stop', async () => {
    const p = await pair();
    try {
      p.a.grant('b', true, true); await flush();
      const old = p.b.getSnapshot().offers.a;
      p.b.mark('a', 'ping', .5, .5); await flush();
      p.a.setSource(source()); await flush();
      expect(p.a.getSnapshot().marks).toEqual([]);
      expect(p.b.getSnapshot().offers).toEqual({});
      p.cb.send(JSON.stringify({ v: 1, type: 'mark', id: 'stale', ...old, kind: 'ping', x: .5, y: .5 })); await flush();
      expect(p.a.getSnapshot().marks).toEqual([]);
      p.a.grant('b', true, false); p.a.setSource(null); await flush();
      expect(p.a.getSnapshot().sharing).toBe(false);
      expect(p.b.getSnapshot().offers).toEqual({});
    } finally { p.close(); }
  });
  it('clears permission when a track ends or participant leaves', async () => {
    const p = await pair();
    try {
      const track = source(); p.a.setSource(track); p.a.grant('b', true, false); await flush();
      track.dispatchEvent(new Event('ended')); await flush();
      expect(p.b.getSnapshot().offers).toEqual({});
      p.a.detach('b'); expect(p.a.getSnapshot().ready).toEqual([]);
      expect(p.ca.readyState).toBe('closed');
    } finally { p.close(); }
  });
  it('rejects invalid coordinates and repeated or flooded indications', async () => {
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      expect(() => p.b.mark('a', 'ping', NaN, .5)).toThrow();
      const grant = p.b.getSnapshot().offers.a;
      for (const x of [-1, 2, null]) p.cb.send(JSON.stringify({ v: 1, type: 'mark', id: crypto.randomUUID(), ...grant, kind: 'ping', x, y: .5 }));
      await flush(); expect(p.a.getSnapshot().marks).toHaveLength(0);
      p.b.mark('a', 'ping', .5, .5); p.b.mark('a', 'ping', .6, .6); await flush();
      expect(p.a.getSnapshot().marks).toHaveLength(1);
    } finally { p.close(); }
  });
  it('does not grant when disabled and fails explicitly under backpressure', async () => {
    const p = await pair();
    try {
      settings.enabled = false; p.a.grant('b', true, true); await flush(); expect(p.b.getSnapshot().offers).toEqual({});
      settings.enabled = true; p.a.grant('b', true, false); await flush();
      p.cb.bufferedAmount = 200_000;
      expect(() => p.b.mark('a', 'ping', .5, .5)).toThrow(/unavailable/);
      expect(p.a.getSnapshot().marks).toEqual([]);
    } finally { p.close(); }
  });
  it('does not let pending captures or reliable buffering stall expendable laser movement', async () => {
    vi.useFakeTimers();
    const p = await pair();
    try {
      p.a.grant('b', true, true); await flush();
      p.cb.hold = true;
      for (let i = 0; i < 4; i++) p.b.mark('a', 'snapshot', .5, .5, image());
      expect(() => p.b.mark('a', 'ping', .5, .5)).toThrow(/previous indications/);
      const status = p.b.getSnapshot().statuses.a;
      p.cb.bufferedAmount = 200_000;
      expect(p.b.mark('a', 'ping', .2, .3, undefined, 0, true)).toBe(true); await flush();
      expect(p.a.getSnapshot().marks[0]).toMatchObject({ laser: true, x: .2 });
      expect(p.b.getSnapshot().statuses.a).toBe(status);
      expect(p.la.sent).toEqual([]);
      expect(p.ca.sent.filter(message => message.type === 'ack')).toEqual([]);
      expect(p.b.mark('a', 'ping', .3, .3, undefined, 0, true)).toBe(false);
      await vi.advanceTimersByTimeAsync(125);
      expect(p.b.mark('a', 'ping', .8, .3, undefined, 0, true)).toBe(true); await flush();
      expect(p.a.getSnapshot().marks[0].x).toBe(.8);
    } finally { p.close(); }
  });
  it('bounds the local trail and rejects reordered, invalid and stale-permission movement', async () => {
    vi.useFakeTimers();
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      p.lb.hold = true;
      p.b.mark('a', 'ping', .2, .3, undefined, 0, true);
      await vi.advanceTimersByTimeAsync(125);
      p.b.mark('a', 'ping', .7, .8, undefined, 0, true);
      p.lb.deliver(1); await flush();
      await vi.advanceTimersByTimeAsync(125);
      p.lb.deliver(0); await flush();
      expect(p.a.getSnapshot().marks[0].x).toBe(.7);
      const old = p.b.getSnapshot().offers.a;
      p.lb.hold = false;
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(125);
        p.b.mark('a', 'ping', .4, .5, undefined, 0, true); await flush();
      }
      const trail = p.a.getSnapshot().marks[0].trail!;
      expect(trail.length).toBeGreaterThan(1); expect(trail.length).toBeLessThanOrEqual(6);
      expect(trail.every(point => performance.now() - point.at < 450)).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      p.b.mark('a', 'ping', .9, .5, undefined, 0, true); await flush();
      expect(p.a.getSnapshot().marks[0].trail).toHaveLength(1);
      p.a.grant('b', true, false); await flush();
      p.lb.send(JSON.stringify({ v: 1, type: 'laser', ...old, sequence: 100, x: .5, y: .5 })); await flush();
      expect(p.a.getSnapshot().marks).toEqual([]);
      const current = p.b.getSnapshot().offers.a;
      for (const x of [NaN, -1, 2]) p.lb.send(JSON.stringify({ v: 1, type: 'laser', ...current, sequence: 100, x, y: .5 }));
      await flush(); expect(p.a.getSnapshot().marks).toEqual([]);
      expect(p.b.mark('a', 'ping', .5, .5, undefined, 0, true)).toBe(true); await flush();
      expect(p.a.getSnapshot().marks[0].x).toBe(.5);
    } finally { p.close(); }
  });
  it('keeps ordinary point and capture rates independent from laser movement', async () => {
    const p = await pair();
    try {
      p.a.grant('b', true, true); await flush();
      p.b.mark('a', 'ping', .2, .3, undefined, 0, true);
      p.b.mark('a', 'ping', .4, .5);
      p.b.mark('a', 'snapshot', .6, .7, image()); await flush();
      expect(p.a.getSnapshot().marks.map(mark => [mark.kind, !!mark.laser])).toEqual([['ping', true], ['ping', false], ['snapshot', false]]);
    } finally { p.close(); }
  });
  it.each([{ legacy: true }, { noLaser: true }])('keeps points and captures available when laser is unsupported: %o', async options => {
    const p = await pair(options);
    try {
      expect(p.b.getSnapshot().laserReady).toEqual([]);
      p.a.grant('b', true, true); await flush();
      expect(p.b.mark('a', 'ping', .2, .3, undefined, 0, true)).toBe(false);
      expect(p.b.mark('a', 'ping', .4, .5)).toBe(true); await flush();
      expect(p.a.getSnapshot().marks[0].laser).not.toBe(true);
      expect(p.b.mark('a', 'snapshot', .6, .7, image())).toBe(true); await flush();
      expect(p.a.getSnapshot().marks.at(-1)?.kind).toBe('snapshot');
    } finally { p.close(); }
  });
  it('requires an open laser channel and cleans up both channels when a participant leaves', async () => {
    const p = await pair();
    try {
      p.lb.readyState = 'connecting'; p.lb.onopen?.();
      expect(p.b.getSnapshot().laserReady).toEqual([]);
      p.a.grant('b', true, false); await flush();
      expect(p.b.mark('a', 'ping', .5, .5, undefined, 0, true)).toBe(false);
      p.lb.readyState = 'open'; p.lb.onopen?.();
      expect(p.b.getSnapshot().laserReady).toEqual(['a']);
      p.b.detach('a');
      expect(p.cb.readyState).toBe('closed'); expect(p.lb.readyState).toBe('closed');
      expect(p.cb.onbufferedamountlow).toBeNull(); expect(p.lb.onmessage).toBeNull();
      expect(p.b.getSnapshot().offers).toEqual({}); expect(p.b.getSnapshot().presentations).toEqual({});
    } finally { p.close(); }
  });
  it('degrades a failed laser channel without interrupting reliable indications', async () => {
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      p.lb.onerror?.();
      expect(p.b.getSnapshot().laserReady).toEqual([]);
      expect(p.lb.readyState).toBe('closed'); expect(p.lb.onmessage).toBeNull();
      expect(p.b.getSnapshot().ready).toEqual(['a']);
      expect(p.b.mark('a', 'ping', .2, .3)).toBe(true); await flush();
      expect(p.a.getSnapshot().marks[0]).toMatchObject({ x: .2, y: .3 });
    } finally { p.close(); }
  });
  it('reconciles only the latest permission and presentation state after reliable backpressure', async () => {
    const p = await pair();
    try {
      p.ca.bufferedAmount = 200_000;
      p.a.grant('b', true, true); p.a.setPresentation({ mode: 'native', state: 'hidden' }); p.a.pause(); await flush();
      expect(p.b.getSnapshot().offers).toEqual({});
      const sent = p.ca.sent.length;
      p.ca.unblock(); await flush();
      expect(p.ca.sent.slice(sent)).toEqual([{ v: 1, type: 'revoke' }]);
      p.ca.bufferedAmount = 200_000;
      p.a.grant('b', true, true); p.a.setPresentation({ mode: 'native', state: 'visible' });
      p.a.grant('b', true, false); p.ca.unblock(); await flush();
      expect(p.b.getSnapshot().offers.a).toMatchObject({ ping: true, snapshot: false });
      expect(p.b.getSnapshot().presentations.a).toEqual({ mode: 'native', state: 'visible' });
      const token = p.b.getSnapshot().offers.a.token;
      p.a.setPresentation({ mode: 'native', state: 'ready' }); await flush();
      expect(p.b.getSnapshot().offers.a.token).toBe(token);
      expect(p.b.getSnapshot().presentations.a.state).toBe('ready');
      const updated = p.ca.sent.length;
      p.a.setPresentation({ mode: 'native', state: 'ready' }); await flush(); expect(p.ca.sent).toHaveLength(updated);
    } finally { p.close(); }
  });
  it('cancels obsolete pending requests on revoke and grant replacement', async () => {
    vi.useFakeTimers();
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      p.cb.hold = true; p.b.mark('a', 'ping', .5, .5);
      const markId = p.cb.sent.at(-1)!.id;
      p.a.pause(); await flush();
      const state = p.b.getSnapshot();
      p.ca.send(JSON.stringify({ v: 1, type: 'ack', id: markId, accepted: true })); await flush();
      await vi.advanceTimersByTimeAsync(6000);
      expect(p.b.getSnapshot()).toBe(state);
      p.a.grant('b', true, false); await flush();
      for (let i = 0; i < 4; i++) p.b.mark('a', 'ping', .5, .5);
      p.a.grant('b', true, false); await flush();
      expect(() => p.b.mark('a', 'ping', .5, .5)).not.toThrow();
    } finally { p.close(); }
  });
  it('keeps delivery and presentation status isolated between simultaneous sharers', async () => {
    const p = await pair(); const c = new VisualCopilot();
    const bc = new Channel(), cb = new Channel(), bl = new Channel(), cl = new Channel();
    bc.remote = cb; cb.remote = bc; bl.remote = cl; cl.remote = bl;
    p.b.attach('c', { createDataChannel: (_label: string, options: RTCDataChannelInit) => options.id === 13 ? bc : bl } as unknown as RTCPeerConnection);
    c.attach('b', { createDataChannel: (_label: string, options: RTCDataChannelInit) => options.id === 13 ? cb : cl } as unknown as RTCPeerConnection);
    await flush(); c.setSource(source());
    try {
      p.a.grant('b', true, false); c.grant('b', true, false); await flush();
      p.a.setPresentation({ mode: 'native', state: 'visible' }); await flush();
      p.b.mark('a', 'ping', .5, .5); await flush();
      cb.hold = true; p.b.mark('c', 'ping', .4, .5); await flush();
      expect(p.b.getSnapshot().statuses).toEqual({ a: 'Received by the sharer.', c: 'Sending indication…' });
      expect(p.b.getSnapshot().presentations).toEqual({ a: { mode: 'native', state: 'visible' }, c: { mode: 'in-app', state: 'ready' } });
      p.b.detach('c');
      expect(p.b.getSnapshot().statuses).toEqual({ a: 'Received by the sharer.' });
      expect(p.b.getSnapshot().presentations).toEqual({ a: { mode: 'native', state: 'visible' } });
    } finally { c.dispose(); p.close(); }
  });
  it('reports older peers without presentation metadata as unknown', async () => {
    const p = await pair();
    try {
      p.a.grant('b', true, false); await flush();
      const grant = p.b.getSnapshot().offers.a;
      p.ca.send(JSON.stringify({ v: 1, type: 'grant', ...grant })); await flush();
      expect(p.b.getSnapshot().offers.a).toEqual(grant);
      expect(p.b.getSnapshot().presentations.a).toBeUndefined();
      p.b.mark('a', 'ping', .5, .5); await flush();
      expect(p.b.getSnapshot().statuses.a).toBe('Received by the sharer.');
    } finally { p.close(); }
  });

  it('keeps manual captures until dismissal while bounding retained marks and timers', async () => {
    vi.useFakeTimers(); settings.cardSeconds = 0;
    const p = await pair();
    try {
      p.a.grant('b', false, true); await flush();
      for (let i = 0; i < 6; i++) {
        p.b.mark('a', 'snapshot', .5, .5, image()); await flush();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(p.a.getSnapshot().marks).toHaveLength(5);
      expect(p.a.getSnapshot().marks.every(mark => mark.expires === Infinity)).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000); expect(p.a.getSnapshot().marks).toHaveLength(5);
      p.a.dismiss(p.a.getSnapshot().marks[0].id); expect(p.a.getSnapshot().marks).toHaveLength(4);
      p.a.setSource(null); await flush(); expect(p.a.getSnapshot().marks).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { p.close(); }
  });
  it('rejects ended sources and all disposed work without retaining listeners or timers', async () => {
    vi.useFakeTimers();
    const p = await pair();
    const ended = source(); Object.assign(ended, { readyState: 'ended' });
    p.a.setSource(ended); p.a.grant('b', true, true); await flush();
    expect(p.a.getSnapshot().sharing).toBe(false); expect(p.b.getSnapshot().offers).toEqual({});
    p.a.setSource(source()); p.a.grant('b', true, true); await flush();
    p.cb.hold = true; p.b.mark('a', 'snapshot', .5, .5, image());
    p.close();
    expect(vi.getTimerCount()).toBe(0); expect(p.b.getSnapshot().ready).toEqual([]);
    expect(() => p.b.mark('a', 'ping', .5, .5)).toThrow(/unavailable/);
    p.a.setSource(source()); p.a.setPresentation({ mode: 'native', state: 'visible' }); p.a.grant('b', true, true);
    expect(p.a.getSnapshot().sharing).toBe(false);
    expect(p.a.getSnapshot().localPresentation).toEqual({ mode: 'in-app', state: 'ready' });
  });
});

describe('frame geometry and input bounds', () => {
  it('maps letterboxing, cropping, scaled and displaced viewports', () => {
    expect(videoPoint(50, 10, { left: 0, top: 0, width: 100, height: 100 }, 200, 100, 'contain')).toBeNull();
    expect(videoPoint(50, 50, { left: 0, top: 0, width: 100, height: 100 }, 200, 100, 'contain')).toEqual({ x: .5, y: .5 });
    expect(videoPoint(0, 50, { left: 0, top: 0, width: 100, height: 100 }, 200, 100, 'cover')).toEqual({ x: .25, y: .5 });
    expect(videoPoint(200, 200, { left: -100, top: 50, width: 400, height: 200 }, 200, 100, 'contain')).toEqual({ x: .75, y: .75 });
    expect(videoPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 0, 0, 'contain')).toBeNull();
  });
  it('rejects oversized, non-JPEG and excessive decoded dimensions', () => {
    expect(isCopilotImage('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isCopilotImage('data:image/jpeg;base64,' + 'A'.repeat(41_000))).toBe(false);
    expect(isCopilotImage('data:image/jpeg;base64,AAAA')).toBe(false);
    const jpeg = (width: number) => 'data:image/jpeg;base64,' + btoa(String.fromCharCode(255, 216, 255, 192, 0, 11, 8, 0, 100, width >> 8, width & 255, 1, 1, 0, 0));
    expect(isCopilotImage(jpeg(320))).toBe(true);
    expect(isCopilotImage(jpeg(4000))).toBe(false);
  });
});
