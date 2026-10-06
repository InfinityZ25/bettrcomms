import { createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { useMountEffect } from '@/hooks/useMountEffect';
import { readStored, writeStored } from '@/lib/storage';
import { publishPreferenceChange, type SyncedSettings } from '@/features/settings/preferenceEvents';
import { THEME_KEY } from '@/features/settings/localPreferences';

type Theme = SyncedSettings['theme'];
type ThemeProviderProps = { children: React.ReactNode; defaultTheme?: Theme; storageKey?: string };
type ThemeProviderState = { theme: Theme; setTheme: (theme: Theme) => void };
const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

function createThemeStore(key: string, fallback: Theme) {
  const read = () => {
    const value = readStored(key);
    return value === 'light' || value === 'dark' || value === 'system' ? value : fallback;
  };
  let theme = read();
  const listeners = new Set<() => void>();
  const refresh = () => {
    const next = read();
    if (theme === next) return;
    theme = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => theme,
    subscribe: (listener: () => void) => {
      if (!listeners.size) { window.addEventListener('bc-theme', refresh); window.addEventListener('storage', refresh); }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { window.removeEventListener('bc-theme', refresh); window.removeEventListener('storage', refresh); }
      };
    },
    set: (next: Theme) => {
      writeStored(key, next);
      refresh();
      if (key === THEME_KEY) publishPreferenceChange({ theme: next });
    },
  };
}
function ThemeAppearance({ theme }: { theme: Theme }) {
  useMountEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme === 'system' ? query.matches ? 'dark' : 'light' : theme);
    };
    apply();
    if (theme === 'system') query.addEventListener('change', apply);
    return () => { query.removeEventListener('change', apply); };
  });
  return null;
}
export function ThemeProvider({ children, defaultTheme = 'system', storageKey = 'vite-ui-theme' }: ThemeProviderProps) {
  const [store] = useState(() => createThemeStore(storageKey, defaultTheme));
  const theme = useSyncExternalStore(store.subscribe, store.snapshot);
  const value = useMemo(() => ({ theme, setTheme: store.set }), [theme, store]);
  return <ThemeProviderContext.Provider value={value}><ThemeAppearance key={theme} theme={theme} />{children}</ThemeProviderContext.Provider>;
}
export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
