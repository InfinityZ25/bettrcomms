import { afterEach, describe, expect, it, vi } from 'vitest';
import { playPushToTalkCue } from './sounds';

describe('push-to-talk sounds', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates brief local tones only when app sounds and volume allow them', () => {
    const values = new Map<string, string>([['bc-sounds', 'off']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
    const makeContext = vi.fn();
    let failStart = false;
    const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
    vi.stubGlobal('AudioContext', class {
      currentTime = 1;
      state = 'running';
      destination = {};
      constructor() { makeContext(); }
      createGain() { return { gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
      createOscillator() {
        const oscillator = { type: '', frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(() => { if (failStart) throw new Error('Audio output lost'); }), stop: vi.fn(), onended: null as (() => void) | null };
        oscillators.push(oscillator);
        return oscillator;
      }
    });
    playPushToTalkCue(true);
    expect(makeContext).not.toHaveBeenCalled();
    values.set('bc-sounds', 'on');
    values.set('bc-sound-volume', '0');
    playPushToTalkCue(true);
    expect(makeContext).not.toHaveBeenCalled();
    values.set('bc-sound-volume', '0.45');
    playPushToTalkCue(true);
    playPushToTalkCue(false);
    expect(makeContext).toHaveBeenCalledOnce();
    expect(oscillators).toHaveLength(2);
    expect(oscillators.every(tone => tone.start.mock.calls.length === 1 && tone.stop.mock.calls.length === 1)).toBe(true);
    oscillators[0].onended?.();
    expect(oscillators[0].disconnect).toHaveBeenCalledOnce();
    failStart = true;
    expect(() => playPushToTalkCue(true)).not.toThrow();
    expect(oscillators[2].stop).toHaveBeenCalledOnce();
    expect(oscillators[2].disconnect).toHaveBeenCalledOnce();
  });
});
