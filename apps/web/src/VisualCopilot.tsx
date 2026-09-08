import { useRef, useState, useSyncExternalStore, type RefObject, type KeyboardEvent } from 'react';
import { Crosshair, Camera, X } from 'lucide-react';
import { VisualCopilot, videoPoint, MAX_IMAGE, type CopilotMode } from './media/visualCopilot';
import { useCopilotSettings } from './VisualCopilotSettings';
import { readTalkSettings } from './media/pushToTalk';
import { useMountEffect } from './useMountEffect';
import { attachCopilotOverlay } from './media/copilotOverlay';
import './VisualCopilot.css';

export function CopilotPanel({ copilot, names }: { copilot: VisualCopilot; names: Record<string, string> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot);
  const settings = useCopilotSettings();
  const [overlayStatus, setOverlayStatus] = useState('');
  return <>
    <CopilotNativeOverlay key={JSON.stringify(names)} copilot={copilot} names={names} onStatus={setOverlayStatus} />
    {state.sharing && <details className="copilot-permissions">
      <summary><Crosshair size={16} /> Visual copilot · {Object.keys(state.grants).length} allowed</summary>
      <p>Permissions apply only to this share. New participants need your permission.</p>
      {!settings.enabled && <p>Enable Visual copilot in Settings to allow indications.</p>}
      {state.ready.length === 0 && <p>Waiting for a compatible participant connection.</p>}
      {state.ready.map(peerId => <fieldset key={peerId}><legend>{names[peerId] ?? 'Participant'}</legend>
        <label><input type="checkbox" disabled={!settings.enabled || !settings.showPings} checked={state.grants[peerId]?.ping ?? false} onChange={e => copilot.grant(peerId, e.target.checked, state.grants[peerId]?.snapshot ?? false)} /> Allow signals from {names[peerId] ?? 'participant'}</label>
        <label><input type="checkbox" disabled={!settings.enabled || !settings.showCards} checked={state.grants[peerId]?.snapshot ?? false} onChange={e => copilot.grant(peerId, state.grants[peerId]?.ping ?? false, e.target.checked)} /> Allow captures from {names[peerId] ?? 'participant'}</label>
      </fieldset>)}
      <button onClick={() => copilot.pause()}>Pause all indications</button>
    </details>}
    {state.sharing && settings.enabled && overlayStatus && <p className="copilot-overlay-status" role="status">{overlayStatus}</p>}
    {settings.enabled && settings.showCards && <aside className={`copilot-cards copilot-cards--${settings.corner}`} aria-label="Marked captures" style={{ width: settings.cardWidth }}>
      {state.marks.filter(m => m.kind === 'snapshot').map(mark => <article className="copilot-card" key={mark.id}>
        <header><strong>{names[mark.peerId] ?? 'Participant'} pointed here</strong><button aria-label="Dismiss marked capture" onClick={() => copilot.dismiss(mark.id)}><X size={15} /></button></header>
        <img src={mark.image} alt={`Frame marked by ${names[mark.peerId] ?? 'participant'}`} />
        <small>Captured frame · held {Math.round((mark.frozenMs ?? 0) / 1000)}s before sending</small>
      </article>)}
    </aside>}
  </>;
}

function CopilotNativeOverlay({ copilot, names, onStatus }: { copilot: VisualCopilot; names: Record<string, string>; onStatus: (message: string) => void }) {
  useMountEffect(() => attachCopilotOverlay(copilot, () => names, onStatus));
  return null;
}

type Frozen = { canvas: HTMLCanvasElement; preview: string; at: number; token: string };
function compress(canvas: HTMLCanvasElement) {
  for (const quality of [.8, .6, .4, .25, .12]) {
    const value = canvas.toDataURL('image/jpeg', quality);
    if (value.length <= MAX_IMAGE) return value;
  }
  throw new Error('This frame is too detailed to send. Try another frame.');
}
export function CopilotViewer({ copilot, peerId, viewport }: { copilot: VisualCopilot; peerId: string; viewport: RefObject<HTMLDivElement | null> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot);
  const settings = useCopilotSettings();
  const grant = state.offers[peerId];
  const [mode, setMode] = useState<CopilotMode | null>(null);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  const [laser, setLaser] = useState(false);
  const [sentPoint, setSentPoint] = useState<{ x: number; y: number } | null>(null);
  const lastMove = useRef(-Infinity);
  const pointTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const movementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMovement = useRef<{ surface: HTMLDivElement; x: number; y: number } | null>(null);
  useMountEffect(() => () => { clearTimeout(pointTimer.current); clearTimeout(movementTimer.current); });
  const scope = useRef<HTMLDivElement>(null);
  const cancel = () => { setMode(null); setFrozen(null); setPoint(null); setError(''); setSentPoint(null); clearTimeout(pointTimer.current); clearTimeout(movementTimer.current); movementTimer.current = undefined; pendingMovement.current = null; };
  function indicate(surface: HTMLDivElement, clientX: number, clientY: number, moving = false) {
    if (moving && performance.now() - lastMove.current < 125) {
      pendingMovement.current = { surface, x: clientX, y: clientY };
      if (movementTimer.current === undefined) movementTimer.current = setTimeout(() => {
        movementTimer.current = undefined;
        const latest = pendingMovement.current; pendingMovement.current = null;
        if (latest?.surface.isConnected) indicate(latest.surface, latest.x, latest.y, true);
      }, Math.ceil(125 - (performance.now() - lastMove.current)));
      return;
    }
    clearTimeout(movementTimer.current); movementTimer.current = undefined; pendingMovement.current = null;
    const video = viewport.current?.querySelector('video');
    if (!video || !video.videoWidth) { setError('Wait for a video frame.'); return; }
    const p = videoPoint(clientX, clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight, getComputedStyle(video).objectFit === 'cover' ? 'cover' : 'contain');
    if (!p) { if (!moving) setError('Click inside the video, outside the black borders.'); return; }
    try {
      copilot.mark(peerId, 'ping', p.x, p.y, undefined, 0, moving);
      lastMove.current = performance.now(); setError('');
      const rect = surface.getBoundingClientRect();
      setSentPoint({ x: (clientX - rect.left) / rect.width * 100, y: (clientY - rect.top) / rect.height * 100 });
      clearTimeout(pointTimer.current); pointTimer.current = setTimeout(() => setSentPoint(null), settings.duration * 1000);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  // Remount the keyed viewer on permission changes to immediately release frames.
  function select(next: CopilotMode) {
    setError('');
    if (next === mode) { cancel(); return; }
    if (!settings.enabled || !grant?.[next]) return;
    if (next === 'snapshot') {
      const video = viewport.current?.querySelector('video');
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) { setError('Wait for a video frame.'); return; }
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
      canvas.width = Math.max(1, Math.round(video.videoWidth * ratio)); canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      setFrozen({ canvas, preview: canvas.toDataURL('image/jpeg', .8), at: performance.now(), token: grant.token });
      setPoint(null);
    } else setFrozen(null);
    setMode(next);
    scope.current?.focus();
  }
  function sendCapture() {
    if (!frozen || !point || frozen.token !== grant?.token) return;
    try {
      const canvas = document.createElement('canvas'); canvas.width = frozen.canvas.width; canvas.height = frozen.canvas.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(frozen.canvas, 0, 0);
      ctx.strokeStyle = '#d2ff88'; ctx.lineWidth = 4; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(point.x * canvas.width, point.y * canvas.height, 15, 0, Math.PI * 2); ctx.stroke();
      copilot.mark(peerId, 'snapshot', point.x, point.y, compress(canvas), performance.now() - frozen.at);
      cancel();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  function shortcut(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); return; }
    if (event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true]'))) return;
    const talk = readTalkSettings();
    if (talk.enabled && talk.binding.kind === 'keyboard' && talk.binding.code === event.code) return;
    if (event.code === settings.pingKey) { event.preventDefault(); select('ping'); }
    else if (event.code === settings.snapshotKey) { event.preventDefault(); select('snapshot'); }
  }
  return <div ref={scope} className={`copilot-viewer ${mode ? 'is-marking' : ''}`} tabIndex={0} role="group" aria-label="Visual collaboration" onKeyDown={shortcut}>
    {mode && <div className="copilot-pointer-surface" role="button" tabIndex={0} aria-label="Mark shared frame: click a location or press Enter for the center" onKeyDown={e => {
      const talk = readTalkSettings();
      if (talk.enabled && talk.binding.kind === 'keyboard' && talk.binding.code === e.code) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); e.stopPropagation();
      try { if (mode === 'snapshot') setPoint({ x: .5, y: .5 }); else copilot.mark(peerId, 'ping', .5, .5); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }} onPointerDown={e => { e.preventDefault(); e.stopPropagation(); if (laser && mode === 'ping' && e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); indicate(e.currentTarget, e.clientX, e.clientY, true); } }}
    onPointerMove={e => { if (laser && mode === 'ping' && e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId)) indicate(e.currentTarget, e.clientX, e.clientY, true); }}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onClick={e => {
      e.stopPropagation();
      if (mode === 'ping') { if (!laser) indicate(e.currentTarget, e.clientX, e.clientY); return; }
      try {
        const video = viewport.current?.querySelector('video');
        const element = mode === 'snapshot' ? e.currentTarget.querySelector('img') : video;
        if (!element || !video) return;
        const p = videoPoint(e.clientX, e.clientY, element.getBoundingClientRect(), mode === 'snapshot' ? frozen!.canvas.width : video.videoWidth, mode === 'snapshot' ? frozen!.canvas.height : video.videoHeight,
          mode === 'snapshot' ? 'contain' : getComputedStyle(video).objectFit === 'cover' ? 'cover' : 'contain');
        if (!p) return;
        if (mode === 'snapshot') setPoint(p);
        else { copilot.mark(peerId, 'ping', p.x, p.y); }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }}>
      {sentPoint && <span className={`copilot-sent-point ${laser ? 'is-laser' : ''}`} style={{ left: `${sentPoint.x}%`, top: `${sentPoint.y}%` }} />}
      {frozen && <><img className="copilot-frozen" src={frozen.preview} alt="Frozen frame to mark" />{point && <svg className="copilot-frozen-marker" viewBox={`0 0 ${frozen.canvas.width} ${frozen.canvas.height}`}><circle cx={point.x * frozen.canvas.width} cy={point.y * frozen.canvas.height} r={15} /></svg>}</>}
    </div>}
    <div className="copilot-toolbar" onPointerDown={e => e.stopPropagation()}>
      <button disabled={!settings.enabled || !grant?.ping} aria-pressed={mode === 'ping' && !laser} onClick={() => { setLaser(false); if (laser) { cancel(); setMode('ping'); } else select('ping'); }}><Crosshair size={15} /> Point</button>
      <button disabled={!settings.enabled || !grant?.ping} aria-pressed={mode === 'ping' && laser} onClick={() => { setLaser(true); if (!laser) { cancel(); setMode('ping'); } else select('ping'); }}>Laser</button>
      <button disabled={!settings.enabled || !grant?.snapshot} aria-pressed={mode === 'snapshot'} onClick={() => select('snapshot')}><Camera size={15} /> Freeze & mark</button>
      {mode === 'snapshot' && <button disabled={!point} onClick={sendCapture}>Send marked capture</button>}
      {mode && <button onClick={cancel}>Back to live</button>}
      <span role="status">{error || (!settings.enabled ? 'Enable visual copilot in Settings' : !state.ready.includes(peerId) ? 'Waiting for visual collaboration. Both clients must use the current version.' : !grant ? 'Ask the sharer to allow you in Visual copilot above the call.' : mode === 'snapshot' ? 'Only your view is frozen. Click to mark.' : mode === 'ping' ? `${laser ? 'Hold and drag on the video. Release to let the laser fade.' : 'Click on the video to point.'} ${state.status}` : 'Choose Point, Laser or Freeze & mark.')}</span>
    </div>
  </div>;
}

export function CopilotViewerSlot(props: { copilot: VisualCopilot; peerId: string; viewport: RefObject<HTMLDivElement | null>; track: MediaStreamTrack }) {
  const state = useSyncExternalStore(props.copilot.subscribe, props.copilot.getSnapshot);
  const settings = useCopilotSettings();
  return <CopilotViewer key={`${props.track.id}:${state.offers[props.peerId]?.token ?? ''}:${settings.enabled}`} {...props} />;
}

export function CopilotLocalMarks({ copilot, fit, names }: { copilot: VisualCopilot; fit: 'fit' | 'fill'; names: Record<string, string> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot);
  const settings = useCopilotSettings();
  const svg = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  useMountEffect(() => {
    const video = svg.current?.parentElement?.querySelector('video');
    if (!video) return;
    const update = () => { if (video.videoWidth) setDimensions({ width: video.videoWidth, height: video.videoHeight }); };
    video.addEventListener('resize', update); update();
    return () => video.removeEventListener('resize', update);
  });
  return <svg ref={svg} className="copilot-local-marks" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio={`xMidYMid ${fit === 'fill' ? 'slice' : 'meet'}`} aria-label="Received signals">
    {settings.enabled && settings.showPings && state.marks.filter(m => m.kind === 'ping').map(mark => <g key={mark.id} transform={`translate(${mark.x * dimensions.width},${mark.y * dimensions.height})`} className={settings.animate ? 'copilot-pulse' : ''}>
      <circle r={mark.laser ? 10 : settings.size} style={mark.laser ? { fill: '#ff665f', stroke: '#fff' } : undefined} /><text y={settings.size + 28} textAnchor="middle">{names[mark.peerId] ?? 'Participant'}</text>
    </g>)}
  </svg>;
}
