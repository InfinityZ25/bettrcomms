import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualCopilot, copilotDefaults, isCopilotImage, videoPoint } from './visualCopilot';

class Channel {
  readyState = 'open'; bufferedAmount = 0;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  remote?: Channel;
  send(data: string) { queueMicrotask(() => this.remote?.onmessage?.({ data })); }
  close() { this.readyState = 'closed'; }
}
let settings = { ...copilotDefaults, enabled: true };
beforeEach(() => { settings = { ...copilotDefaults, enabled: true }; vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(settings) }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function source() { const track = new EventTarget(); return Object.assign(track, { readyState: 'live', id: crypto.randomUUID() }) as unknown as MediaStreamTrack; }
async function pair() {
  const a = new VisualCopilot(), b = new VisualCopilot();
  const ca = new Channel(), cb = new Channel(); ca.remote = cb; cb.remote = ca;
  a.attach('b', { createDataChannel: () => ca } as unknown as RTCPeerConnection);
  b.attach('a', { createDataChannel: () => cb } as unknown as RTCPeerConnection);
  ca.onopen?.(); cb.onopen?.(); await flush();
  a.setSource(source());
  return { a, b, ca, cb, close: () => { a.dispose(); b.dispose(); } };
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
      p.cb.bufferedAmount = 1;
      await vi.advanceTimersByTimeAsync(125);
      p.b.mark('a', 'ping', .9, .8, undefined, 0, true); await flush();
      expect(p.a.getSnapshot().marks[0].x).toBe(.7);
      await vi.advanceTimersByTimeAsync(2000);
      expect(p.a.getSnapshot().marks).toHaveLength(0);
      p.cb.bufferedAmount = 0;
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
