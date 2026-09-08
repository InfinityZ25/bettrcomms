import { invoke, isTauri } from '@tauri-apps/api/core';
import { nativeScreenSessionForTrack } from './nativeCaptureRegistry';
import { readCopilotSettings, type CopilotMark, type VisualCopilot } from './visualCopilot';

let activeRenderer: symbol | undefined;

export function attachCopilotOverlay(copilot: VisualCopilot, names: () => Record<string, string>, onStatus: (message: string) => void = () => {}) {
  if (!isTauri()) { onStatus('Browser sharing: indications appear inside BetterComms only. Share from the current Windows desktop build to show them over the shared application.'); return () => {}; }
  const renderer = Symbol('copilot overlay');
  activeRenderer = renderer;
  let stopped = false;
  let busy = false;
  let signature = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStatus = '';
  let checkedHost = false;
  const status = (message: string) => { if (!stopped && activeRenderer === renderer && message !== lastStatus) { lastStatus = message; onStatus(message); } };
  const rendered = new Map<string, { pixels: Uint8Array; width: number; height: number }>();
  const clear = () => activeRenderer === renderer ? invoke('copilot_overlay_clear').catch(() => {}) : Promise.resolve();
  async function draw(mark: CopilotMark, size: number, cardWidth: number) {
    const canvas = document.createElement('canvas');
    canvas.width = mark.kind === 'ping' ? 180 : cardWidth;
    canvas.height = mark.kind === 'ping' ? 180 : Math.min(340, Math.round(cardWidth * 9 / 16) + 48);
    const ctx = canvas.getContext('2d')!;
    const name = (names()[mark.peerId] ?? 'Participant').slice(0, 28);
    if (mark.kind === 'ping') {
      ctx.strokeStyle = mark.laser ? '#fff' : '#d2ff88'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(90, 90, mark.laser ? 6 : size / 2, 0, Math.PI * 2);
      if (mark.laser) { ctx.fillStyle = '#ff665f'; ctx.fill(); } ctx.stroke();
      ctx.fillStyle = '#e4ffcb'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(name, 90, 90 + size / 2 + 20, 170);
    } else {
      const image = new Image(); image.src = mark.image!;
      try {
        await image.decode();
        if (image.naturalWidth > 640 || image.naturalHeight > 640) throw new Error('Invalid marked capture dimensions');
        ctx.fillStyle = '#17211a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#c9f18d'; ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
        ctx.fillStyle = '#e4ffcb'; ctx.font = '13px sans-serif'; ctx.fillText(`${name} pointed here`, 8, 18, canvas.width - 16);
        const ratio = Math.min((canvas.width - 16) / image.naturalWidth, (canvas.height - 52) / image.naturalHeight);
        const w = image.naturalWidth * ratio, h = image.naturalHeight * ratio;
        ctx.drawImage(image, (canvas.width - w) / 2, 26, w, h);
        ctx.fillStyle = '#b6c4b5'; ctx.font = '11px sans-serif'; ctx.fillText('Captured frame · dismiss in BetterComms', 8, canvas.height - 10, canvas.width - 16);
      } finally { image.src = ''; }
    }
    return { pixels: new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer), width: canvas.width, height: canvas.height };
  }
  async function tick() {
    if (stopped || busy || activeRenderer !== renderer) return;
    busy = true;
    try {
      const settings = readCopilotSettings();
      const track = copilot.getSource();
      const session = track ? nativeScreenSessionForTrack(track) : undefined;
      if (!checkedHost) {
        await invoke('copilot_overlay_clear');
        checkedHost = true;
      }
      if (!session) status('Desktop browser capture: indications appear inside BetterComms only. Restart sharing and select a native window or display to show them over the source.');
      else if (!copilot.getSnapshot().marks.length) status('Native overlay ready. Keep the shared application visible and in front to see received signals there.');
      const available = settings.enabled && session ? copilot.getSnapshot().marks.filter(m => m.expires > performance.now() && (m.kind === 'ping' ? settings.showPings : settings.showCards)) : [];
      // One capture card at a time outside the app; all retained cards are in the app.
      const lastCard = available.filter(m => m.kind === 'snapshot').at(-1);
      const marks = available.filter(m => m.kind === 'ping').slice(-4).concat(lastCard ? [lastCard] : []);
      const next = `${session}:${marks.map(m => m.id).join(',')}:${settings.size}:${settings.corner}:${settings.cardWidth}`;
      if (next !== signature) { await clear(); rendered.clear(); signature = next; }
      for (const mark of marks) {
        if (stopped || activeRenderer !== renderer) break;
        let frame = rendered.get(mark.id);
        if (!frame) { frame = await draw(mark, settings.size, settings.cardWidth); rendered.set(mark.id, frame); }
        if (stopped || activeRenderer !== renderer) break;
        await invoke('copilot_overlay_frame', frame.pixels, { headers: {
          'x-copilot-id': mark.id, 'x-copilot-session': session!, 'x-copilot-corner': mark.kind === 'ping' ? 'point' : settings.corner,
          'x-copilot-width': String(frame.width), 'x-copilot-height': String(frame.height), 'x-copilot-x': String(mark.x), 'x-copilot-y': String(mark.y),
        } });
      }
      if (marks.length) status('Native overlay receiving signals. They appear over the shared application when it is in front.');
    } catch (e) { await clear(); status(`External overlay unavailable. ${!checkedHost ? 'Use the local development desktop build; this host does not support the overlay commands. ' : ''}${e instanceof Error ? e.message : String(e)}`); }
    finally { busy = false; if (stopped) { rendered.clear(); await clear(); } else if (copilot.getSnapshot().marks.length) timer = setTimeout(() => void tick(), 350); }
  }
  const unsubscribe = copilot.subscribe(() => { if (!busy) { clearTimeout(timer); void tick(); } });
  void tick();
  return () => { stopped = true; unsubscribe(); clearTimeout(timer); rendered.clear(); if (!busy) void clear(); };
}
