import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  dragRegionStyle,
  getDesktopRuntime,
  getDesktopWindowApi,
  isDesktopShell,
  nativeNonClientRegion,
  noDragStyle,
  type DesktopWindowApi,
} from '@/desktop';
import { AudioLines, Minus, Square, Copy, X } from 'lucide-react';
import {
  getWindowControls,
  subscribeToWindowControls,
  type WindowButton,
  type WindowControlsState,
} from './windowControls';
import { syncNativeCaptionTheme } from './nativeCaptionTheme';

export default function DesktopFrame({ children }: { children: ReactNode }) {
  // Either desktop shell gets the custom frame; only the Tauri host owns the
  // native caption theme, which better-gui publishes and Wails does not have.
  const desktop = isDesktopShell();
  const tauri = getDesktopRuntime() === 'tauri';
  // Memoised because the api is a fresh object each call, and it is an effect
  // dependency below.
  const windowApi = useMemo(() => getDesktopWindowApi(), []);
  const controls = useSyncExternalStore(
    subscribeToWindowControls,
    getWindowControls,
  );
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!tauri || !['native-frame', 'native-overlay'].includes(controls.mode))
      return;
    return syncNativeCaptionTheme();
  }, [tauri, controls.mode]);
  useEffect(() => {
    if (!windowApi) return;
    let disposed = false;
    const update = () =>
      windowApi
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    void update();
    // The webview resizes whenever the window does, on both hosts, so one DOM
    // listener replaces the host-specific resize subscription.
    window.addEventListener('resize', update);
    return () => {
      disposed = true;
      window.removeEventListener('resize', update);
    };
  }, [windowApi]);
  if (!desktop || !windowApi || controls.mode === 'native-frame')
    return children;
  const run = (action: () => Promise<unknown>) => {
    setError('');
    void action().catch(() =>
      setError('Window action failed. Please try again.'),
    );
  };
  // Windows y macOS dibujan sus propios botones encima de la pagina, asi que
  // `buttons` llega vacio y aqui no se pinta nada que compita con ellos.
  const windowControls =
    controls.buttons.length > 0 ? (
      <div
        className={
          controls.platform === 'linux'
            ? 'flex items-center gap-2 px-2.5'
            : 'flex h-full'
        }
        role="group"
        aria-label="Window controls"
        style={noDragStyle()}
      >
        {controls.buttons.map((button) => (
          <WindowControlButton
            api={windowApi}
            button={button}
            key={button}
            maximized={maximized}
            compact={controls.platform === 'linux'}
            run={run}
          />
        ))}
      </div>
    ) : null;
  return (
    <div data-desktop-frame className="flex h-dvh flex-col overflow-hidden">
      <div
        className={titlebarClassName(controls)}
        style={
          {
            '--desktop-titlebar-height': `${controls.height}px`,
            '--desktop-titlebar-inset-start': `${controls.insetStart}px`,
            '--desktop-titlebar-inset-end': `${controls.insetEnd}px`,
          } as CSSProperties
        }
      >
        {controls.buttonSide === 'start' ? windowControls : null}
        <div
          className={
            controls.platform === 'macos'
              ? 'flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-[0.7rem] text-muted-foreground [&>svg]:text-primary'
              : 'flex h-full min-w-0 flex-1 items-center gap-2 pl-4 text-[0.7rem] text-muted-foreground [&>svg]:text-primary'
          }
          data-wails-non-client-region={nativeNonClientRegion('caption')}
          style={dragRegionStyle()}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            if (event.detail === 2) run(() => windowApi.toggleMaximize());
            else run(() => windowApi.startDragging());
          }}
        >
          <AudioLines size={14} aria-hidden="true" />
          <span>BetterComms</span>
        </div>
        {error && (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
        {controls.buttonSide === 'end' ? windowControls : null}
      </div>
      {children}
    </div>
  );
}

function WindowControlButton({
  api,
  button,
  maximized,
  compact,
  run,
}: {
  api: DesktopWindowApi;
  button: WindowButton;
  maximized: boolean;
  compact: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const buttonClass = compact
    ? 'grid size-[22px] place-items-center rounded-full bg-muted transition-colors hover:bg-accent focus-visible:outline-offset-2'
    : 'grid h-full w-[46px] place-items-center rounded-none transition-colors hover:bg-accent focus-visible:outline-offset-[-3px]';
  if (button === 'minimize') {
    return (
      <button
        className={buttonClass}
        data-wails-non-client-region={nativeNonClientRegion(button)}
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => run(() => api.minimize())}
      >
        <Minus size={15} />
      </button>
    );
  }

  if (button === 'maximize') {
    return (
      <button
        className={buttonClass}
        data-wails-non-client-region={nativeNonClientRegion(button)}
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => run(() => api.toggleMaximize())}
      >
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
    );
  }

  return (
    <button
      className={`${buttonClass} hover:bg-destructive hover:text-white`}
      data-wails-non-client-region={nativeNonClientRegion(button)}
      aria-label="Close window"
      title="Close"
      onClick={() => run(() => api.close())}
    >
      <X size={17} />
    </button>
  );
}

function titlebarClassName(controls: WindowControlsState) {
  const classes = [
    'flex h-(--desktop-titlebar-height) shrink-0 basis-(--desktop-titlebar-height) select-none items-center bg-sidebar ps-(--desktop-titlebar-inset-start) pe-(--desktop-titlebar-inset-end)',
  ];

  // WebView2 solo trata la barra como region no cliente si lleva esta clase:
  // el propio host la usa para refrescar el arrastre al restaurar la ventana.
  if (controls.mode === 'native-overlay') {
    classes.push('better-window-titlebar');
  }

  return classes.join(' ');
}
