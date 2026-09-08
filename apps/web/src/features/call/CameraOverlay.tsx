import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { PictureInPicture2 } from 'lucide-react';
import { isWindowsDesktop } from '@/media/permissions';
import { CameraOverlayCanvas, type OverlayCamera } from '@/media/cameraOverlayCanvas';
import './CameraOverlay.css';

type Settings = { position: string; size: string; clickThrough: boolean };
type Session = { overlayId: string; width: number; height: number; maxFps: number };
const defaults: Settings = { position: 'top-right', size: 'small', clickThrough: true };
function readSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem('bc-camera-overlay') ?? '{}');
    return {
      position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value.position) ? value.position : defaults.position,
      size: ['small', 'medium', 'large'].includes(value.size) ? value.size : defaults.size,
      clickThrough: value.clickThrough !== false,
    };
  } catch { return defaults; }
}

export default function CameraOverlay({ cameras }: { cameras: OverlayCamera[] }) {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState(readSettings);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [status, setStatus] = useState('');
  const latest = useRef({ cameras, settings, includeSelf });
  latest.current = { cameras, settings, includeSelf };
  useEffect(() => { let active = true; void isWindowsDesktop().then(value => { if (active) setSupported(value); }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!enabled || !supported) return;
    let stopped = false;
    let session: Session | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let applied = '';
    const canvas = new CameraOverlayCanvas();
    const close = () => {
      if (session) { const id = session.overlayId; session = undefined; void invoke('camera_overlay_close', { overlayId: id }).catch(() => {}); }
    };
    const tick = async () => {
      const started = performance.now();
      try {
        const current = latest.current;
        const visible = current.cameras.filter(camera => (current.includeSelf || camera.id !== 'self') && camera.track.enabled && camera.track.readyState === 'live').slice(0, 4);
        const options = { ...current.settings, rows: Math.max(1, visible.length) };
        const key = JSON.stringify(options);
        if (!session) {
          session = await invoke<Session>('camera_overlay_open', options);
          applied = key;
        } else if (applied !== key) {
          session = await invoke<Session>('camera_overlay_update', { overlayId: session.overlayId, ...options });
          applied = key;
        }
        if (stopped) { close(); return; }
        const rgba = canvas.render(visible, session.width, session.height);
        await invoke('camera_overlay_frame', rgba, { headers: {
          'x-bettercomms-overlay-id': session.overlayId,
          'x-bettercomms-frame-width': String(session.width),
          'x-bettercomms-frame-height': String(session.height),
        } });
        // Modern hosts pace the single in-flight frame on an absolute native
        // deadline. A second JS timer would add scheduling drift. Older hosts
        // still discard early frames, so preserve their advertised cadence.
        if (!stopped) timer = setTimeout(() => void tick(), session.maxFps === 24 ? 0 : Math.max(0, Math.ceil(1000 / Math.min(24, session.maxFps || 10) - (performance.now() - started))));
      } catch (error) {
        close();
        if (!stopped) {
          setEnabled(false);
          const message = String(error);
          setStatus(/not found/i.test(message) ? 'Install desktop version 0.1.6 or newer to use the camera overlay.' : 'Overlay stopped. You can reopen it; the call is still connected.');
        }
      }
    };
    void tick();
    const unload = () => { stopped = true; clearTimeout(timer); close(); canvas.dispose(); };
    window.addEventListener('pagehide', unload);
    return () => { unload(); window.removeEventListener('pagehide', unload); };
  }, [enabled, supported]);
  if (!isTauri() || !supported) return null;
  const change = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem('bc-camera-overlay', JSON.stringify(next));
  };
  return <details className="camera-overlay-controls">
    <summary><PictureInPicture2 size={16} /> Camera overlay{enabled ? ' · On' : ''}</summary>
    <div className="camera-overlay-panel">
      <strong>Your friends, above your game</strong>
      <p>Up to four cameras on this app’s display. Works over windowed and borderless fullscreen games. Exclusive fullscreen may cover the overlay.</p>
      <label>Screen corner<select aria-label="Overlay screen corner" value={settings.position} onChange={event => change({ position: event.target.value })}>
        <option value="top-right">Top right</option><option value="top-left">Top left</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option>
      </select></label>
      <label>Camera size<select aria-label="Overlay camera size" value={settings.size} onChange={event => change({ size: event.target.value })}>
        <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
      </select></label>
      <label>Let clicks pass to the game<input type="checkbox" checked={settings.clickThrough} onChange={event => change({ clickThrough: event.target.checked })} /></label>
      <label>Include my camera<input type="checkbox" checked={includeSelf} onChange={event => setIncludeSelf(event.target.checked)} /></label>
      <button className={enabled ? '' : 'overlay-primary'} onClick={() => { setStatus(''); setEnabled(!enabled); }}>{enabled ? 'Hide camera overlay' : 'Show camera overlay'}</button>
      <p>View only · no extra microphone or camera capture. Closes when you leave the call.</p>
      {status && <p role="status">{status}</p>}
    </div>
  </details>;
}
