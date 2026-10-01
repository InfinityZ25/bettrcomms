import { clearNativeCopilot, syncNativeCopilot, uploadNativeCopilotFrame, type NativeCopilotPosition } from '../desktop/copilot';
import { getDesktopCapabilities } from '../desktop/capabilities';
import { nativeScreenSessionForTrack } from './nativeCaptureRegistry';
import { readCopilotSettings, type CopilotMark, type CopilotPresentation, type VisualCopilot } from './visualCopilot';
import { drawCopilotArtwork } from './copilotArtwork';

let activeRenderer: symbol | undefined;
let nativeQueue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeQueue.then(operation, operation);
  nativeQueue = result.catch(() => {});
  return result;
}

export function attachCopilotOverlay(copilot: VisualCopilot, names: () => Record<string, string>, onStatus: (message: string) => void = () => {}) {
  if (getDesktopCapabilities().nativeOverlays.state === 'unavailable') {
    copilot.setPresentation({ mode: 'in-app', state: 'ready' }, 'Signals and captures appear inside BetterComms. External overlays need native Windows sharing.');
    onStatus('Signals and captures appear inside BetterComms. External overlays need native Windows sharing.');
    return () => {};
  }
  const renderer = Symbol('copilot overlay');
  activeRenderer = renderer;
  let stopped = false, busy = false, dirty = false, initialized = false;
  let session = '', failedSession = '', lastStatus = '', artworkIssue = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const artwork = new Map<string, { signature: string; frame: Awaited<ReturnType<typeof drawCopilotArtwork>> }>();
  const uploaded = new Set<string>();
  const revisions = new Map<string, { mark: CopilotMark; revision: number }>();
  const ownsHost = () => activeRenderer === renderer;
  const current = () => !stopped && ownsHost();
  const sourceSession = () => { const track = copilot.getSource(); return track ? nativeScreenSessionForTrack(track) ?? '' : ''; };
  const publish = (presentation: CopilotPresentation, message: string) => {
    if (!current()) return;
    copilot.setPresentation(presentation, message);
    if (lastStatus !== message) { lastStatus = message; onStatus(message); }
  };
  const clear = () => serial(async () => { if (ownsHost()) await clearNativeCopilot(); }).catch(() => {});
  const sourceUnavailable = () => {
    uploaded.clear();
    publish({ mode: 'in-app', state: 'unavailable' }, 'Shared source unavailable. Signals remain inside BetterComms and external overlays resume when the source returns. Restart sharing if its size changed.');
  };
  const marksForSource = (): CopilotMark[] => {
    const settings = readCopilotSettings();
    if (!settings.enabled || !sourceSession()) return [];
    const marks = copilot.getSnapshot().marks.filter(mark => mark.expires > performance.now() && (mark.kind === 'ping' ? settings.showPings : settings.showCards));
    const card = marks.filter(mark => mark.kind === 'snapshot').at(-1);
    return [...marks.filter(mark => mark.kind === 'ping').slice(-4), ...(card ? [card] : [])];
  };
  const positions = (marks: CopilotMark[]): NativeCopilotPosition[] => {
    const now = performance.now(), settings = readCopilotSettings();
    return marks.filter(mark => mark.expires > now).map(mark => {
      const previous = revisions.get(mark.id);
      const revision = previous ? previous.revision + (previous.mark === mark ? 0 : 1) : 1;
      revisions.set(mark.id, { mark, revision });
      return {
      markId: mark.id, corner: mark.kind === 'ping' ? 'point' : settings.corner, x: mark.x, y: mark.y,
      remainingMs: Number.isFinite(mark.expires) ? Math.max(1, Math.ceil(mark.expires - now)) : 60_000,
      revision,
      trail: (settings.animate ? mark.trail ?? [] : []).filter(point => now - point.at <= 450).map(point => ({ x: point.x, y: point.y, ageMs: Math.max(0, Math.ceil(now - point.at)) })),
    }; });
  };
  async function tick() {
    if (!current() || busy) return;
    busy = true; dirty = false;
    try {
      const nextSession = sourceSession();
      if (!initialized || session !== nextSession) {
        await clear();
        if (!current()) return;
        initialized = true; session = nextSession; failedSession = ''; artworkIssue = ''; artwork.clear(); uploaded.clear(); revisions.clear();
      }
      if (!session) {
        publish({ mode: 'in-app', state: 'ready' }, 'Signals and captures appear inside BetterComms. Select a native window or display to show them over the source.');
        return;
      }
      if (session === failedSession) return;
      const targetSession = session;
      const marks = marksForSource();
      const ids = new Set(marks.map(mark => mark.id));
      for (const id of revisions.keys()) if (!ids.has(id)) revisions.delete(id);
      for (const id of artwork.keys()) if (!ids.has(id)) { artwork.delete(id); uploaded.delete(id); }
      for (const mark of marks) {
        const settings = readCopilotSettings(), name = names()[mark.peerId] ?? 'Participant';
        const signature = `${mark.kind}:${mark.laser}:${settings.size}:${settings.cardWidth}:${name}:${mark.image ?? ''}`;
        if (artwork.get(mark.id)?.signature !== signature) {
          try {
            const frame = await drawCopilotArtwork(mark, settings.size, settings.cardWidth, name);
            if (!current() || sourceSession() !== targetSession) return;
            artwork.set(mark.id, { signature, frame }); uploaded.delete(mark.id); artworkIssue = '';
          } catch {
            if (!current() || sourceSession() !== targetSession) return;
            copilot.dismiss(mark.id);
            artworkIssue = 'An unreadable indication was discarded. Other signals can continue.';
          }
        }
      }
      await serial(async () => {
        if (!current() || sourceSession() !== targetSession) return;
        // Prune individual surfaces before uploading replacements; unchanged artwork stays native.
        let active = marksForSource();
        let result = await syncNativeCopilot({ sessionId: targetSession, marks: positions(active) });
        for (const id of result.missing) uploaded.delete(id);
        if (result.state === 'unavailable') { sourceUnavailable(); return; }
        let changed = false;
        for (const mark of active) {
          if (!current() || sourceSession() !== targetSession) return;
          if (!marksForSource().some(value => value.id === mark.id) || uploaded.has(mark.id)) continue;
          const entry = artwork.get(mark.id);
          if (!entry) { dirty = true; continue; }
          const settings = readCopilotSettings();
          await uploadNativeCopilotFrame({ markId: mark.id, sessionId: targetSession, corner: mark.kind === 'ping' ? 'point' : settings.corner, width: entry.frame.width, height: entry.frame.height, x: mark.x, y: mark.y }, entry.frame.pixels);
          uploaded.add(mark.id);
          changed = true;
        }
        if (!current() || sourceSession() !== targetSession) return;
        active = marksForSource();
        if (changed) result = await syncNativeCopilot({ sessionId: targetSession, marks: positions(active) });
        if (result.state === 'unavailable') { sourceUnavailable(); return; }
        const state = active.length ? result.state : 'ready';
        publish({ mode: 'native', state }, artworkIssue || (state === 'hidden'
          ? 'External signals are hidden while the shared application is not in front. They remain visible inside BetterComms.'
          : state === 'visible' ? 'Signals and captures are visible over the shared source.' : 'Native overlay ready. Signals appear over the shared source when it is visible.'));
      });
    } catch (error) {
      // A source can minimize between the geometry check and a frame upload.
      // Retry that transient state only while indications remain; broken host APIs stop retries.
      const status = session && current() ? await serial(() => syncNativeCopilot({ sessionId: session, marks: [] })).catch(() => undefined) : undefined;
      if (status?.state === 'unavailable') sourceUnavailable();
      else {
        await clear(); artwork.clear(); uploaded.clear(); failedSession = session;
        publish({ mode: 'in-app', state: 'unavailable' }, `External overlay unavailable. Signals remain inside BetterComms. ${error instanceof Error ? error.message : 'Restart sharing to retry.'}`);
      }
    } finally {
      busy = false;
      if (stopped) { artwork.clear(); uploaded.clear(); revisions.clear(); await clear(); }
      else if (current() && dirty) queueMicrotask(() => void tick());
      else if (current() && session && session !== failedSession && marksForSource().length) timer = setTimeout(() => void tick(), 750);
    }
  }
  const schedule = () => {
    if (!current()) return;
    clearTimeout(timer);
    if (busy) dirty = true;
    else void tick();
  };
  let previousMarks = copilot.getSnapshot().marks, previousSource = copilot.getSource();
  const unsubscribe = copilot.subscribe(() => {
    const snapshot = copilot.getSnapshot(), source = copilot.getSource();
    if (snapshot.marks === previousMarks && source === previousSource) return;
    previousMarks = snapshot.marks; previousSource = source; schedule();
  });
  const settingsChanged = () => schedule();
  if (typeof window !== 'undefined') {
    window.addEventListener('bc-visual-copilot', settingsChanged);
    window.addEventListener('storage', settingsChanged);
  }
  void tick();
  return () => {
    stopped = true; unsubscribe(); clearTimeout(timer); artwork.clear(); uploaded.clear(); revisions.clear();
    if (typeof window !== 'undefined') { window.removeEventListener('bc-visual-copilot', settingsChanged); window.removeEventListener('storage', settingsChanged); }
    if (!busy) void clear();
  };
}
