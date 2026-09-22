import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** Resolve the actual CSS palette, including OKLCH, to Win32's sRGB bytes. */
export function syncNativeCaptionTheme() {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;background:var(--sidebar);color:var(--sidebar-foreground)';
  document.body.append(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let frame = 0;
  let previous = '';
  const publish = () => {
    if (!context) return;
    const style = getComputedStyle(probe);
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const palette = {
      background: rgb(style.backgroundColor),
      foreground: rgb(style.color),
      dark: document.documentElement.classList.contains('dark'),
    };
    const key = JSON.stringify(palette);
    if (key === previous) return;
    previous = key;
    void emitTo(
      { kind: 'Webview', label: getCurrentWebview().label },
      'better-gui:caption-theme',
      palette,
    ).catch(() => { previous = ''; });
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(publish);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    probe.remove();
  };
}
