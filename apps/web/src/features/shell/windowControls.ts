/**
 * Reads the window-control state the desktop host publishes.
 *
 * Who draws the minimize/maximize/close buttons depends on the desktop, and
 * only the host can tell: Windows owns the non-client frame outside the page,
 * macOS keeps its own traffic lights, and Linux expects the app to draw
 * them in the order `gtk-decoration-layout` asks for. Wails publishes this
 * state in its boot report before the page runs.
 */

import { readDesktopBootReport } from '@/desktop';

export type WindowButton = 'minimize' | 'maximize' | 'close';
export type ButtonSide = 'start' | 'end';
export type ControlsMode =
  | 'native-frame'
  | 'native-overlay'
  | 'native-traffic-lights'
  | 'client-side';
export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'ios' | 'unknown';

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

// The bar carries a search field and the notification button as well as the
// window's own controls, so it is taller than a bar that only holds a title.
// Has to agree with titlebarHeight in the Wails host's capabilities.go.
const TITLEBAR_HEIGHT = 40;
// Ancho de los semaforos de macOS mas su margen, en pixeles logicos. Tiene que
// match the native macOS traffic-light placement in the Wails host.
const MACOS_TRAFFIC_LIGHT_INSET = 78;
const WINDOW_BUTTONS: WindowButton[] = ['minimize', 'maximize', 'close'];

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
}

type NavigatorWithOverlay = Navigator & {
  windowControlsOverlay?: WindowControlsOverlay;
};

export function subscribeToWindowControls(onChange: () => void) {
  const overlay = (navigator as NavigatorWithOverlay).windowControlsOverlay;
  // El overlay de WebView2 cambia de ancho al maximizar y al cambiar el idioma
  // del sistema, y eso mueve el area util de la barra.
  overlay?.addEventListener('geometrychange', onChange);
  return () => {
    overlay?.removeEventListener('geometrychange', onChange);
  };
}

let cached = defaultWindowControls();
let cachedKey = JSON.stringify(cached);

/**
 * `useSyncExternalStore` compares snapshots by identity, so the same state has
 * to come back as the same object or React re-renders forever.
 */
export function getWindowControls(): WindowControlsState {
  const published = readDesktopBootReport()?.windowControls;
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
    isOneOf(state.platform, ['windows', 'macos', 'linux', 'ios', 'unknown']) &&
    isOneOf(state.mode, [
      'native-frame',
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
