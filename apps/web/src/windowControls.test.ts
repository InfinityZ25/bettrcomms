import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDesktopPlatform, getWindowControls } from './windowControls';

function publish(state: unknown) {
  vi.stubGlobal('window', { __BETTER_WINDOW_CONTROLS__: state });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('platform detection', () => {
  it('reads the platform the webview reports', () => {
    for (const [agent, platform] of [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', 'windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 'macos'],
      ['Mozilla/5.0 (X11; Linux x86_64) Chrome/140', 'linux'],
    ] as const) {
      vi.stubGlobal('navigator', { userAgent: agent });
      expect(detectDesktopPlatform()).toBe(platform);
    }
  });
});

describe('published window controls', () => {
  const state = {
    platform: 'linux',
    mode: 'client-side',
    height: 32,
    insetStart: 0,
    insetEnd: 0,
    buttons: ['close', 'maximize'],
    buttonSide: 'start',
  };

  it('keeps the order and side the host published', () => {
    publish(state);

    const controls = getWindowControls();
    expect(controls.buttons).toEqual(['close', 'maximize']);
    expect(controls.buttonSide).toBe('start');
  });

  it('returns the same snapshot object while nothing changes', () => {
    publish(state);

    // useSyncExternalStore compara por identidad: un objeto nuevo en cada
    // lectura deja a React re-renderizando sin parar.
    expect(getWindowControls()).toBe(getWindowControls());
  });

  it('returns a new snapshot once the host republishes something different', () => {
    publish(state);
    const before = getWindowControls();

    publish({ ...state, buttons: ['minimize', 'maximize', 'close'] });
    const after = getWindowControls();

    expect(after).not.toBe(before);
    expect(after.buttons).toEqual(['minimize', 'maximize', 'close']);
  });

  it('falls back to a usable title bar when the state is missing or malformed', () => {
    // Sin un estado valido la ventana se quedaria sin forma de cerrarse, asi
    // que cualquier cosa que no valide vuelve a los tres botones.
    for (const malformed of [
      undefined,
      null,
      'native-overlay',
      { ...state, buttons: ['quit'] },
      { ...state, height: -1 },
      { ...state, buttonSide: 'middle' },
      { ...state, mode: 'native' },
    ]) {
      publish(malformed);

      const controls = getWindowControls();
      expect(controls.mode).toBe('client-side');
      expect(controls.buttons).toEqual(['minimize', 'maximize', 'close']);
      expect(controls.buttonSide).toBe('end');
    }
  });
});
