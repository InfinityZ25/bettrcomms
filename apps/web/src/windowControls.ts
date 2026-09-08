/**
 * Reads the window-control state the `better-gui` Tauri plugin publishes.
 *
 * Who draws the minimize/maximize/close buttons depends on the desktop, and
 * only the host can tell: WebView2 paints the real Windows buttons over the
 * page, macOS keeps its own traffic lights, and Linux expects the app to draw
 * them in the order `gtk-decoration-layout` asks for. The plugin resolves that
 * once and publishes it on `window.__BETTER_WINDOW_CONTROLS__`.
 *
 * The publish can land after the first render (on macOS and Linux it is an
 * `eval` into an already-running page), so this module starts from a guess made
 * from the user agent and swaps to the real state when it arrives. The guess
 * matches what each platform ends up with in the common case, which keeps the
 * title bar from flashing a different set of buttons.
 */

export type WindowButton = 'minimize' | 'maximize' | 'close';
export type ButtonSide = 'start' | 'end';
export type ControlsMode =
  | 'native-overlay'
  | 'native-traffic-lights'
  | 'client-side';
export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export interface WindowControlsState {
  platform: DesktopPlatform;
  /** Who draws the buttons. */
  mode: ControlsMode;
  /** Title bar height in CSS pixels. */
  height: number;
  /** Pixels to reserve before the title bar content. */
  insetStart: number;
  /** Pixels to reserve after the title bar content. */
  insetEnd: number;
  /** Buttons the page draws itself, already in the platform's own order. */
  buttons: WindowButton[];
  buttonSide: ButtonSide;
}

const TITLEBAR_HEIGHT = 32;
// Ancho de los semaforos de macOS mas su margen, en pixeles logicos. Tiene que
// concordar con `trafficLightPosition` de tauri.macos.conf.json.
const MACOS_TRAFFIC_LIGHT_INSET = 78;
const WINDOW_BUTTONS: WindowButton[] = ['minimize', 'maximize', 'close'];

const CHANGE_EVENT = 'better-window-controls-change';

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
}

type WindowWithControls = Window & {
  __BETTER_WINDOW_CONTROLS__?: unknown;
};

type NavigatorWithOverlay = Navigator & {
  windowControlsOverlay?: WindowControlsOverlay;
};

export function subscribeToWindowControls(onChange: () => void) {
  const overlay = (navigator as NavigatorWithOverlay).windowControlsOverlay;
  // El overlay de WebView2 cambia de ancho al maximizar y al cambiar el idioma
  // del sistema, y eso mueve el area util de la barra.
  overlay?.addEventListener('geometrychange', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    overlay?.removeEventListener('geometrychange', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

let cached = defaultWindowControls();
let cachedKey = JSON.stringify(cached);

/**
 * `useSyncExternalStore` compares snapshots by identity, so the same state has
 * to come back as the same object or React re-renders forever.
 */
export function getWindowControls(): WindowControlsState {
  const published = (window as WindowWithControls).__BETTER_WINDOW_CONTROLS__;
  const next = isWindowControlsState(published)
    ? published
    : defaultWindowControls();
  const key = JSON.stringify(next);

  if (key !== cachedKey) {
    cachedKey = key;
    cached = next;
  }

  return cached;
}

export function detectDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'unknown';
  const agent = navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos';
  if (/Windows/i.test(agent)) return 'windows';
  if (/Linux|X11|CrOS/i.test(agent)) return 'linux';
  return 'unknown';
}

function defaultWindowControls(): WindowControlsState {
  const platform = detectDesktopPlatform();

  if (platform === 'macos') {
    return {
      platform,
      mode: 'native-traffic-lights',
      height: TITLEBAR_HEIGHT,
      insetStart: MACOS_TRAFFIC_LIGHT_INSET,
      insetEnd: 0,
      buttons: [],
      buttonSide: 'start',
    };
  }

  return {
    platform,
    mode: 'client-side',
    height: TITLEBAR_HEIGHT,
    insetStart: 0,
    insetEnd: 0,
    buttons: WINDOW_BUTTONS,
    buttonSide: 'end',
  };
}

/**
 * The global is set by an injected script, so it is validated rather than
 * trusted: a half-written state would leave the window with no way to close.
 */
function isWindowControlsState(value: unknown): value is WindowControlsState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;

  return (
    isOneOf(state.platform, ['windows', 'macos', 'linux', 'unknown']) &&
    isOneOf(state.mode, [
      'native-overlay',
      'native-traffic-lights',
      'client-side',
    ]) &&
    isSize(state.height) &&
    isSize(state.insetStart) &&
    isSize(state.insetEnd) &&
    Array.isArray(state.buttons) &&
    state.buttons.every((button) => isOneOf(button, WINDOW_BUTTONS)) &&
    isOneOf(state.buttonSide, ['start', 'end'])
  );
}

function isOneOf<T extends string>(value: unknown, allowed: T[]): value is T {
  return typeof value === 'string' && (allowed as string[]).includes(value);
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
