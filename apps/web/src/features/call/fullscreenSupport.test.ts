import { describe, expect, it } from 'vitest';
import { canUseFullscreen } from './fullscreenSupport';
describe('fullscreen capability on phone WebKit', () => {
  it('requires both an enabled API and a callable method', () => {
    expect(canUseFullscreen({})).toBe(false);
    expect(canUseFullscreen({ fullscreenEnabled: true })).toBe(false);
    expect(
      canUseFullscreen({
        fullscreenEnabled: false,
        documentElement: { requestFullscreen() {} },
      }),
    ).toBe(false);
    expect(
      canUseFullscreen({
        fullscreenEnabled: true,
        documentElement: { requestFullscreen() {} },
      }),
    ).toBe(true);
  });
});
