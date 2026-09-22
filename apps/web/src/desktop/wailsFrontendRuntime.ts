import { getDesktopRuntime } from './runtime';

/**
 * Loads the Wails frontend runtime, once, at startup.
 *
 * This is not a convenience. Three of the runtime's modules do their work as
 * import side effects, and the one this application depends on is
 * `appregion`: it walks the document for elements carrying
 * `--wails-non-client-region`, converts their boxes to physical pixels, and
 * reports them to the host, which is how Windows comes to hit-test our own
 * title bar as caption and as HTMINBUTTON / HTMAXBUTTON / HTCLOSE. Without it
 * the host's region list stays empty — it is cleared on every navigation — so
 * `NonClientRegionSupport` falls back to WebView2's `app-region` reading,
 * which knows how to drag a window and nothing about caption buttons. No
 * native hover, no Snap Layouts, and the buttons work only through the click
 * handlers the page wires as a fallback.
 *
 * Every call into the runtime in this codebase is a dynamic import inside the
 * function that needs it, so nothing pulled the package in until somebody
 * pressed a button — which is exactly one press too late for a title bar.
 *
 * Ordering is not a concern: the host injects its runtime configuration on
 * navigation-completed and then dispatches `wails:runtime-config-ready`, and
 * the region tracker waits for that event when it finds no configuration yet.
 *
 * See https://v3.wails.io/features/windows/frameless/ — "Native non-client
 * regions on Windows".
 */
let started = false;

/** Returns whether this call is the one that started the load. */
export function startWailsFrontendRuntime(): boolean {
  if (started || getDesktopRuntime() !== 'wails') return false;
  started = true;
  // Failure is survivable and must not take the page with it: the title bar
  // keeps its own click handlers, which is what the browser build uses.
  void import('@wailsio/runtime').catch(() => {});
  return true;
}

/** Test seam. Product code starts the runtime exactly once. */
export function resetWailsFrontendRuntime(): void {
  started = false;
}
