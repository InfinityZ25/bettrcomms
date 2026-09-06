import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AudioLines, Minus, Square, Copy, X } from 'lucide-react';

export default function DesktopFrame({ children }: { children: ReactNode }) {
  const desktop = isTauri();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const update = () =>
      appWindow
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    void update();
    const listener = appWindow.onResized(update);
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten());
    };
  }, [desktop]);
  if (!desktop) return children;
  const run = (action: () => Promise<unknown>) => {
    setError('');
    void action().catch(() =>
      setError('Window action failed. Please try again.'),
    );
  };
  return (
    <div className="desktop-frame">
      <div className="desktop-titlebar">
        <div
          className="desktop-drag-area"
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            if (event.detail === 2)
              run(() => getCurrentWindow().toggleMaximize());
            else run(() => getCurrentWindow().startDragging());
          }}
        >
          <AudioLines size={14} aria-hidden="true" />
          <span>BetterComms</span>
        </div>
        {error && (
          <span className="desktop-window-error" role="alert">
            {error}
          </span>
        )}
        <div className="desktop-window-controls">
          <button
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => run(() => getCurrentWindow().minimize())}
          >
            <Minus size={15} />
          </button>
          <button
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => run(() => getCurrentWindow().toggleMaximize())}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            className="desktop-close"
            aria-label="Close window"
            title="Close"
            onClick={() => run(() => getCurrentWindow().close())}
          >
            <X size={17} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
