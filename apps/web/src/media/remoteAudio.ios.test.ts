import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/desktop/runtime', () => ({
  readDesktopBootReport: () => ({ platform: 'ios' }),
}));
vi.mock('./output', () => ({ followOutputDevice: () => () => {} }));

import {
  attachRemoteAudio,
  disposeCallPlayback,
  getCallPlaybackStatus,
  prepareCallPlayback,
  setCallPlaybackDeafened,
} from './remoteAudio';

afterEach(() => {
  disposeCallPlayback();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('plays iPhone remote audio through a media element that does not depend on Web Audio', () => {
  const audioContext = vi.fn(() => { throw new Error('Web Audio should not run on iPhone'); });
  vi.stubGlobal('AudioContext', audioContext);
  vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { mediaDevices: new EventTarget() });
  vi.stubGlobal('localStorage', { getItem: () => null });
  class FakeAudio extends EventTarget {
    autoplay = false;
    hidden = false;
    muted = false;
    volume = 1;
    dataset: Record<string, string> = {};
    srcObject: unknown = null;
    play = vi.fn(async () => {});
    pause = vi.fn();
    setAttribute = vi.fn();
    remove() { attached = null; }
  }
  let attached: FakeAudio | null = null;
  const currentElement = (): FakeAudio => {
    if (!attached) throw new Error('Remote audio element was not attached');
    return attached;
  };
  vi.stubGlobal('document', {
    createElement: () => new FakeAudio(),
    body: { append: (element: FakeAudio) => { attached = element; } },
  });

  prepareCallPlayback();
  const track = new EventTarget() as MediaStreamTrack;
  const detach = attachRemoteAudio({ track, peerId: 'friend', balanceVoice: true });
  const element = currentElement();

  expect(element.srcObject).toBeTruthy();
  expect(element.play).toHaveBeenCalled();
  expect(audioContext).not.toHaveBeenCalled();
  expect(getCallPlaybackStatus().tracks).toBe(1);

  setCallPlaybackDeafened(true);
  expect(element.muted).toBe(true);
  detach();
  expect(attached).toBeNull();
  expect(getCallPlaybackStatus().tracks).toBe(0);
});
