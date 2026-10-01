import { useRef, useState, useSyncExternalStore, type RefObject, type KeyboardEvent, type PointerEvent } from 'react';
import { Crosshair, Camera, X, MousePointer2 } from 'lucide-react';
import { VisualCopilot, videoPoint, MAX_IMAGE, type CopilotMode, type CopilotPresentation } from '@/media/visualCopilot';
import { useCopilotSettings } from '@/features/settings/VisualCopilotSettings';
import { readTalkSettings } from '@/media/pushToTalk';
import { useMountEffect } from '@/hooks/useMountEffect';
import { errorMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import './VisualCopilot.css';

function presentationLabel(presentation?: CopilotPresentation) {
  if (!presentation) return 'The other client has not reported where signals appear.';
  if (presentation.mode === 'in-app') return presentation.state === 'unavailable'
    ? 'Inside BetterComms · external overlay unavailable' : 'Inside BetterComms';
  if (presentation.state === 'hidden') return 'Over shared source · hidden while another app is in front';
  if (presentation.state === 'visible') return 'Over shared source · visible';
  if (presentation.state === 'unavailable') return 'External overlay unavailable';
  return 'Over shared source · ready';
}

export function CopilotPanel({ copilot, names }: { copilot: VisualCopilot; names: Record<string, string> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot);
  const settings = useCopilotSettings();
  return <>
    {state.sharing && <div className="copilot-sharer">
      <CopilotPermissions key={copilot.getSource()?.id} copilot={copilot} names={names} />
      {settings.enabled && <p className="copilot-overlay-status">{state.presentationDetail || presentationLabel(state.localPresentation)}</p>}
    </div>}
    {settings.enabled && settings.showCards && state.marks.some(mark => mark.kind === 'snapshot') &&
      <aside className={`copilot-cards copilot-cards--${settings.corner}`} aria-label="Marked captures" style={{ width: settings.cardWidth }}>
        {state.marks.filter(mark => mark.kind === 'snapshot').map(mark => <article className="copilot-card" key={mark.id}>
          <header><strong>{names[mark.peerId] ?? 'Participant'} pointed here</strong><Button variant="ghost" size="icon-sm" aria-label="Dismiss marked capture" onClick={() => copilot.dismiss(mark.id)}><X size={15} /></Button></header>
          <img src={mark.image} alt={`Frame marked by ${names[mark.peerId] ?? 'participant'}`} />
          <small>Captured frame · held {Math.round((mark.frozenMs ?? 0) / 1000)}s before sending</small>
        </article>)}
      </aside>}
  </>;
}

function CopilotPermissions({ copilot, names }: { copilot: VisualCopilot; names: Record<string, string> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot);
  const settings = useCopilotSettings();
  const [open, setOpen] = useState(true);
  return <details className="copilot-permissions" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Crosshair size={16} /> Visual copilot · {Object.keys(state.grants).length} allowed</summary>
    <p>Choose who can point or send a marked frame. Permissions end when this share stops.</p>
    {!settings.enabled && <p>Enable Visual copilot in Voice & devices settings on both devices first.</p>}
    {state.ready.length === 0 && <p>Waiting for a compatible participant connection.</p>}
    <div className="copilot-permission-list">
      {state.ready.map(peerId => <fieldset key={peerId}><legend>{names[peerId] ?? 'Participant'}</legend>
        <label><input type="checkbox" disabled={!settings.enabled || !settings.showPings} checked={state.grants[peerId]?.ping ?? false} onChange={event => copilot.grant(peerId, event.target.checked, state.grants[peerId]?.snapshot ?? false)} /> Allow signals from {names[peerId] ?? 'participant'}</label>
        <label><input type="checkbox" disabled={!settings.enabled || !settings.showCards} checked={state.grants[peerId]?.snapshot ?? false} onChange={event => copilot.grant(peerId, state.grants[peerId]?.ping ?? false, event.target.checked)} /> Allow captures from {names[peerId] ?? 'participant'}</label>
      </fieldset>)}
    </div>
    <Button variant="secondary" size="sm" disabled={!Object.keys(state.grants).length} onClick={() => copilot.pause()}>Pause all indications</Button>
  </details>;
}

type Frozen = { canvas: HTMLCanvasElement; preview: string; at: number; token: string };
async function compress(canvas: HTMLCanvasElement) {
  for (const quality of [.65, .4, .2, .1]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not encode this frame.');
    if (blob.size > 29_980) continue;
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read this frame.'));
      reader.readAsDataURL(blob);
    });
    if (image.length <= MAX_IMAGE) return image;
  }
  throw new Error('This frame is too detailed to send. Capture a simpler frame.');
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
  const [sending, setSending] = useState(false);
  const [sentPoint, setSentPoint] = useState<{ x: number; y: number } | null>(null);
  const frozenRef = useRef<Frozen | null>(null), scope = useRef<HTMLDivElement>(null);
  const generation = useRef(0), stroke = useRef<number | null>(null), lastMove = useRef(-Infinity);
  const pointTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const movementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frozenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMovement = useRef<{ surface: HTMLDivElement; x: number; y: number } | null>(null);
  const clearMovement = () => { clearTimeout(movementTimer.current); movementTimer.current = undefined; pendingMovement.current = null; stroke.current = null; copilot.stopLaser(peerId); };
  const releaseFrame = () => { if (frozenRef.current) { frozenRef.current.canvas.width = 0; frozenRef.current.canvas.height = 0; frozenRef.current = null; } clearTimeout(frozenTimer.current); };
  useMountEffect(() => {
    const blur = () => clearMovement();
    window.addEventListener('blur', blur);
    return () => { ++generation.current; clearMovement(); clearTimeout(pointTimer.current); releaseFrame(); window.removeEventListener('blur', blur); };
  });
  const cancel = () => {
    ++generation.current; clearMovement(); releaseFrame(); clearTimeout(pointTimer.current);
    setMode(null); setFrozen(null); setPoint(null); setError(''); setSentPoint(null); setSending(false);
  };
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
    const location = videoPoint(clientX, clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight, getComputedStyle(video).objectFit === 'cover' ? 'cover' : 'contain');
    if (!location) { if (!moving) setError('Click inside the video, outside the black borders.'); return; }
    try {
      const sent = copilot.mark(peerId, 'ping', location.x, location.y, undefined, 0, moving);
      lastMove.current = performance.now();
      if (!sent) { setError('Connection busy · movement skipped'); return; }
      setError('');
      const rect = surface.getBoundingClientRect();
      setSentPoint({ x: (clientX - rect.left) / rect.width * 100, y: (clientY - rect.top) / rect.height * 100 });
      clearTimeout(pointTimer.current); pointTimer.current = setTimeout(() => setSentPoint(null), settings.duration * 1000);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  function select(next: CopilotMode, asLaser = false) {
    if (mode === next && (next !== 'ping' || laser === asLaser)) { cancel(); return; }
    cancel();
    if (!settings.enabled || !grant?.[next] || (asLaser && !state.laserReady.includes(peerId))) return;
    if (next === 'snapshot') {
      const video = viewport.current?.querySelector('video');
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) { setError('Wait for a video frame.'); return; }
      const canvas = document.createElement('canvas');
      try {
        const ratio = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * ratio)); canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not capture this frame.');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = { canvas, preview: canvas.toDataURL('image/jpeg', .7), at: performance.now(), token: grant.token };
        frozenRef.current = frame; setFrozen(frame);
        frozenTimer.current = setTimeout(() => { cancel(); setError('Frozen frame expired. Capture a new frame.'); }, 60_000);
      } catch (cause) { canvas.width = 0; canvas.height = 0; setError(errorMessage(cause)); return; }
    }
    setLaser(asLaser); setMode(next); scope.current?.focus();
  }
  async function sendCapture() {
    if (!frozen || !point || sending || frozen.token !== grant?.token) return;
    const currentGeneration = ++generation.current;
    setSending(true); setError('');
    const canvas = document.createElement('canvas'); canvas.width = frozen.canvas.width; canvas.height = frozen.canvas.height;
    try {
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Could not draw this marked frame.');
      ctx.drawImage(frozen.canvas, 0, 0); ctx.strokeStyle = '#d2ff88'; ctx.lineWidth = 4; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(point.x * canvas.width, point.y * canvas.height, 15, 0, Math.PI * 2); ctx.stroke();
      const image = await compress(canvas);
      if (currentGeneration !== generation.current || copilot.getSnapshot().offers[peerId]?.token !== frozen.token) return;
      copilot.mark(peerId, 'snapshot', point.x, point.y, image, performance.now() - frozen.at);
      cancel();
    } catch (cause) { if (currentGeneration === generation.current) setError(errorMessage(cause)); }
    finally { canvas.width = 0; canvas.height = 0; if (currentGeneration === generation.current) setSending(false); }
  }
  function shortcut(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); return; }
    if (event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true]'))) return;
    const talk = readTalkSettings();
    if (talk.enabled && talk.binding.kind === 'keyboard' && talk.binding.code === event.code) return;
    if (event.code === settings.pingKey) { event.preventDefault(); select('ping'); }
    else if (event.code === settings.snapshotKey) { event.preventDefault(); select('snapshot'); }
  }
  const finishStroke = (event: PointerEvent<HTMLDivElement>, canceled = false) => {
    stroke.current = null;
    if (canceled) clearMovement();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const inputReserved = (button: number) => { const talk = readTalkSettings(); return talk.enabled && talk.binding.kind === 'mouse' && talk.binding.button === button; };
  const instruction = mode === 'snapshot' ? 'Frozen locally · click to mark, then send' : mode === 'ping' ? laser ? 'Hold and drag · release to fade' : 'Click to point' : 'Choose Point, Laser or Freeze & mark';
  return <div ref={scope} className={`copilot-viewer ${mode ? 'is-marking' : ''}`} tabIndex={0} role="group" aria-label="Visual collaboration" onKeyDown={shortcut}>
    {mode && <div className="copilot-pointer-surface" role="button" tabIndex={0} aria-label="Mark shared frame: click a location or press Enter for the center"
      onKeyDown={event => {
        const talk = readTalkSettings();
        if (talk.enabled && talk.binding.kind === 'keyboard' && talk.binding.code === event.code) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation();
        try { if (mode === 'snapshot') setPoint({ x: .5, y: .5 }); else copilot.mark(peerId, 'ping', .5, .5); }
        catch (cause) { setError(errorMessage(cause)); }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        if (inputReserved(event.button)) { setError('This mouse button is assigned to push-to-talk. Use Enter to point, or change that binding.'); return; }
        event.preventDefault(); event.stopPropagation();
        if (laser && mode === 'ping') { stroke.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); indicate(event.currentTarget, event.clientX, event.clientY, true); }
      }}
      onPointerMove={event => { if (laser && mode === 'ping' && stroke.current === event.pointerId && event.buttons === 1) indicate(event.currentTarget, event.clientX, event.clientY, true); }}
      onPointerUp={event => finishStroke(event)} onPointerCancel={event => finishStroke(event, true)}
      onLostPointerCapture={() => { if (stroke.current !== null) clearMovement(); }}
      onClick={event => {
        event.stopPropagation();
        if (inputReserved(event.button)) return;
        if (mode === 'ping') { if (!laser) indicate(event.currentTarget, event.clientX, event.clientY); return; }
        if (!frozen || sending) return;
        const image = event.currentTarget.querySelector('img'); if (!image) return;
        const location = videoPoint(event.clientX, event.clientY, image.getBoundingClientRect(), frozen.canvas.width, frozen.canvas.height, 'contain');
        if (location) setPoint(location);
      }}>
      {sentPoint && <span className={`copilot-sent-point ${laser ? 'is-laser' : ''}`} style={{ left: `${sentPoint.x}%`, top: `${sentPoint.y}%` }} />}
      {frozen && <><img className="copilot-frozen" src={frozen.preview} alt="Frozen frame to mark" />{point && <svg className="copilot-frozen-marker" viewBox={`0 0 ${frozen.canvas.width} ${frozen.canvas.height}`}><circle cx={point.x * frozen.canvas.width} cy={point.y * frozen.canvas.height} r={15} /></svg>}</>}
    </div>}
    <div className="copilot-toolbar" onPointerDown={event => event.stopPropagation()}>
      <div className="copilot-tools">
        <Button variant="ghost" size="sm" disabled={!settings.enabled || !grant?.ping} aria-pressed={mode === 'ping' && !laser} onClick={() => select('ping')}><Crosshair size={15} /> Point</Button>
        <Button variant="ghost" size="sm" disabled={!settings.enabled || !grant?.ping || !state.laserReady.includes(peerId)} title={state.laserReady.includes(peerId) ? 'Hold and drag to indicate a path' : 'Laser needs an updated client and a live movement connection'} aria-pressed={mode === 'ping' && laser} onClick={() => select('ping', true)}><MousePointer2 size={15} /> Laser</Button>
        <Button variant="ghost" size="sm" disabled={!settings.enabled || !grant?.snapshot} aria-pressed={mode === 'snapshot'} onClick={() => select('snapshot')}><Camera size={15} /> Freeze & mark</Button>
        {mode === 'snapshot' && <Button variant="secondary" size="sm" disabled={!point || sending} onClick={() => void sendCapture()}>{sending ? 'Preparing…' : 'Send marked capture'}</Button>}
        {mode && <Button variant="ghost" size="sm" onClick={cancel}>Back to live</Button>}
      </div>
      <p role="status" className="copilot-status">{error || (!settings.enabled ? 'Turn on Visual copilot in Voice & devices settings' : !state.ready.includes(peerId) ? 'Waiting for a compatible connection' : !grant ? 'Ask the sharer to allow you in Visual copilot above their call' : laser && mode === 'ping' ? instruction : state.statuses[peerId] || instruction)}</p>
      {mode && !laser && state.statuses[peerId] && <p className="copilot-instruction">{instruction}</p>}
      {grant && <p className="copilot-presentation">{presentationLabel(state.presentations[peerId])}</p>}
    </div>
  </div>;
}

export function CopilotViewerSlot(props: { copilot: VisualCopilot; peerId: string; viewport: RefObject<HTMLDivElement | null>; track: MediaStreamTrack }) {
  const state = useSyncExternalStore(props.copilot.subscribe, props.copilot.getSnapshot), settings = useCopilotSettings();
  return <CopilotViewer key={`${props.track.id}:${state.offers[props.peerId]?.token ?? ''}:${settings.enabled}`} {...props} />;
}

export function CopilotLocalMarks({ copilot, fit, names }: { copilot: VisualCopilot; fit: 'fit' | 'fill'; names: Record<string, string> }) {
  const state = useSyncExternalStore(copilot.subscribe, copilot.getSnapshot), settings = useCopilotSettings();
  const svg = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  useMountEffect(() => {
    const video = svg.current?.parentElement?.querySelector('video'); if (!video) return;
    const update = () => { if (video.videoWidth) setDimensions({ width: video.videoWidth, height: video.videoHeight }); };
    video.addEventListener('resize', update); update(); return () => video.removeEventListener('resize', update);
  });
  return <svg ref={svg} className="copilot-local-marks" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio={`xMidYMid ${fit === 'fill' ? 'slice' : 'meet'}`} aria-label="Received signals">
    {settings.enabled && settings.showPings && state.marks.filter(mark => mark.kind === 'ping').map(mark =>
      <g key={mark.id} transform={`translate(${mark.x * dimensions.width},${mark.y * dimensions.height})`} className={`copilot-mark ${mark.laser && settings.animate ? 'is-laser' : settings.animate ? 'copilot-pulse' : ''}`}>
        {settings.animate && mark.trail?.slice(0, -1).map(sample => {
          const remaining = Math.max(0, 450 - (performance.now() - sample.at));
          return remaining > 0 && <circle key={sample.at} className="copilot-trail-point" cx={(sample.x - mark.x) * dimensions.width} cy={(sample.y - mark.y) * dimensions.height} r={5} style={{ opacity: remaining / 450 * .65, animationDuration: `${remaining}ms` }} />;
        })}
        <circle className="copilot-marker-head" r={mark.laser ? 10 : settings.size} style={mark.laser ? { fill: '#ff665f', stroke: '#fff' } : undefined} />
        <text y={settings.size + 28} textAnchor="middle">{names[mark.peerId] ?? 'Participant'}</text>
      </g>)}
  </svg>;
}
