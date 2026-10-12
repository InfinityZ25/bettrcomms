import { getDesktopRuntime, readDesktopBootReport } from '@/desktop/runtime';

export function youtubeRequiresBrowser(): boolean {
  return (
    getDesktopRuntime() === 'wails' &&
    readDesktopBootReport()?.platform !== 'windows'
  );
}
