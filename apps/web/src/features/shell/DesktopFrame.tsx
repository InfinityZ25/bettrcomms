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
import { ArrowLeft, ArrowRight, Bell, Minus, Search, Square, Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getWindowControls,
  subscribeToWindowControls,
  type WindowButton,
  type WindowControlsState,
} from './windowControls';
import { syncNativeCaptionTheme } from './nativeCaptionTheme';
import {
  getHistoryNavigation,
  subscribeToHistoryNavigation,
} from './historyNavigation';

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
  // A back button that cannot go back is a control that does nothing. The
  // browser will not answer that question, so the application keeps count.
  const history_ = useSyncExternalStore(
    subscribeToHistoryNavigation,
    getHistoryNavigation,
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
  const dragArea = (
    <div
      className="h-full min-w-0 flex-1"
      data-wails-non-client-region={nativeNonClientRegion('caption')}
      style={dragRegionStyle()}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if (event.detail === 2) run(() => windowApi.toggleMaximize());
        else run(() => windowApi.startDragging());
      }}
    />
  );
  return (
    <div data-desktop-frame className="flex h-dvh w-full flex-col overflow-hidden">
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
        {/*
          Three parts: what is on either side, and the search between them.

          The two sides are flex-1 from a zero basis, so they take the same
          width whatever they hold and the field lands on the centre of the
          window rather than the centre of whatever space the controls left
          over. The drag area is inside them, which is what keeps it from
          covering the field: the host hit-tests the caption as a rectangle
          read from this element's box, so anything drawn over that box is a
          window drag before it is ever a click.

          The sidebar toggle is not here. It belongs next to the sidebar it
          opens, which is in the page; the bar keeps what is about the window
          itself, plus the two things that belong to no single screen.
        */}
        <div className="flex h-full min-w-0 flex-1 basis-0 items-center">
          <div className="flex items-center gap-0.5 ps-1.5" style={noDragStyle()} aria-label="Navigation controls">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg text-muted-foreground"
              aria-label="Go back"
              title="Back"
              disabled={!history_.canGoBack}
              onClick={() => history.back()}
            >
              <ArrowLeft size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg text-muted-foreground"
              aria-label="Go forward"
              title="Forward"
              disabled={!history_.canGoForward}
              onClick={() => history.forward()}
            >
              <ArrowRight size={15} />
            </Button>
          </div>
          {dragArea}
        </div>

        <TitlebarSearch />

        <div className="flex h-full min-w-0 flex-1 basis-0 items-center justify-end">
          {dragArea}
          {error && (
            <span className="px-2 text-xs text-destructive" role="alert">
              {error}
            </span>
          )}
          <Notifications />
          {controls.buttonSide === 'end' ? windowControls : null}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * The search field, present and deliberately inert.
 *
 * There is nothing to search yet, so this wires to nothing: it holds the place
 * and settles where the field lives before anything depends on the answer.
 * Typing into it does nothing, which is the honest behaviour until there is
 * something to look through.
 */
function TitlebarSearch() {
  return (
    <div
      className="hidden w-[min(420px,34vw)] shrink-0 min-[720px]:block"
      style={noDragStyle()}
    >
      <div className="relative flex items-center">
        <Search
          size={13}
          aria-hidden="true"
          className="pointer-events-none absolute start-2.5 text-muted-foreground"
        />
        <input
          type="text"
          aria-label="Search"
          placeholder="Search"
          spellCheck={false}
          className="h-7 w-full rounded-lg border border-border/70 bg-background/50 ps-8 pe-2.5 text-xs text-foreground transition-colors placeholder:text-muted-foreground hover:bg-background/80 focus:bg-background focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        />
      </div>
    </div>
  );
}

/**
 * What happened while you were looking elsewhere.
 *
 * It sits beside the window buttons because it belongs to the window rather
 * than to whichever screen is open. Nothing feeds it yet, so it says so
 * instead of showing a count that would always read zero.
 */
function Notifications() {
  return (
    <div style={noDragStyle()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg text-muted-foreground"
              aria-label="Notifications"
              title="Notifications"
            />
          }
        >
          <Bell size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">
            Nothing here yet. Calls and messages you miss will land in this
            list.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
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
    'flex h-(--desktop-titlebar-height) shrink-0 basis-(--desktop-titlebar-height) select-none items-center gap-1 bg-sidebar ps-(--desktop-titlebar-inset-start) pe-(--desktop-titlebar-inset-end)',
  ];

  // WebView2 solo trata la barra como region no cliente si lleva esta clase:
  // el propio host la usa para refrescar el arrastre al restaurar la ventana.
  if (controls.mode === 'native-overlay') {
    classes.push('better-window-titlebar');
  }

  return classes.join(' ');
}
