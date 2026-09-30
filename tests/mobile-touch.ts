import type { Page } from '@playwright/test';

// Use touch events rather than mouse drags: both native WKWebView and mobile
// browsers deliver these events. Production layout and API remain real.
export async function swipe(
  page: Page,
  from: [number, number],
  to: [number, number],
  selector?: string,
) {
  if (
    !selector &&
    page.context().browser()?.browserType().name() === 'chromium'
  ) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from[0], y: from[1] }],
      });
      for (const fraction of [0.2, 0.6, 1])
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: from[0] + (to[0] - from[0]) * fraction,
              y: from[1] + (to[1] - from[1]) * fraction,
            },
          ],
        });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    } finally {
      await cdp.detach();
    }
    return;
  }
  // Desktop WebKit does not expose a constructible Touch, even in mobile
  // emulation. Deliver the same touch sequence to the app's event listeners;
  // the real iPhone's system gesture delivery still requires acceptance.
  await page.evaluate(
    ({ from, to, selector }) => {
      const target = (
        selector
          ? document.querySelector(selector)
          : document.elementFromPoint(...from)
      )!;
      const send = (type: string, point: [number, number]) => {
        const touch = {
          identifier: 1,
          target,
          clientX: point[0],
          clientY: point[1],
        };
        const active = type === 'touchend' ? [] : [touch];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: active },
          targetTouches: { value: active },
          changedTouches: { value: [touch] },
        });
        target.dispatchEvent(event);
      };
      send('touchstart', from);
      send('touchmove', to);
      send('touchend', to);
    },
    { from, to, selector },
  );
}
