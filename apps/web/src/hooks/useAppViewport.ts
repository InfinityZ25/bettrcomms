import { useEffect } from 'react';
import { PHONE_QUERY } from './use-mobile';

/** Keep the app in the visible viewport when a mobile keyboard pans WebKit. */
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const phone = window.matchMedia(PHONE_QUERY);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editing = document.activeElement?.matches(
          'input:not([readonly]), textarea, [contenteditable="true"]',
        );
        // Pinch zoom remains a browser accessibility feature. Don't relayout
        // a zoomed page or interpret rotation/browser chrome as a keyboard.
        const keyboard =
          phone.matches &&
          editing &&
          viewport.scale === 1 &&
          window.innerHeight - viewport.height > 120;
        root.dataset.keyboardOpen = keyboard ? 'true' : 'false';
        if (viewport.scale !== 1) return;
        root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
        root.style.setProperty(
          '--app-viewport-top',
          `${keyboard ? viewport.offsetTop : 0}px`,
        );
      });
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      delete root.dataset.keyboardOpen;
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--app-viewport-top');
    };
  }, []);
}
