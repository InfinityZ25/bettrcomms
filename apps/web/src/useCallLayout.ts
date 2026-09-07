import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
type Dock = 'top' | 'left' | 'right';
const readSize = (key: string, fallback: number) => { try { const n = Number(localStorage.getItem(key)); return n > 0 && Number.isFinite(n) ? n : fallback; } catch { return fallback; } };
export function useCallLayout(layout: string, onLayout?: (value: string) => void, joined = false) {
  const stage = useRef<HTMLDivElement>(null);
  const dock: Dock = layout === 'side' || layout === 'left' ? 'left' : layout === 'right' ? 'right' : 'top';
  const [extent, setExtent] = useState({ width: 1000, height: 600 });
  const [sizes, setSizes] = useState(() => ({ top: readSize('bc-camera-row-size', 190), side: readSize('bc-camera-side-size', 300) }));
  const [target, setTarget] = useState<Dock | null>(null);
  const pending = useRef<Dock | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; size: number } | null>(null);
  // The stage mounts only after joining. Observe its actual available space.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setExtent({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, [joined]);
  const horizontal = dock === 'top' || window.innerWidth <= 700;
  const minimum = horizontal ? 100 : 180;
  const maximum = Math.max(minimum, Math.min(horizontal ? 420 : 560, (horizontal ? extent.height : extent.width) * 0.48));
  const size = Math.max(minimum, Math.min(maximum, horizontal ? sizes.top : sizes.side));
  const setSize = (value: number) => {
    const next = Math.max(minimum, Math.min(maximum, value));
    setSizes(old => ({ ...old, [horizontal ? 'top' : 'side']: next }));
    try { localStorage.setItem(horizontal ? 'bc-camera-row-size' : 'bc-camera-side-size', String(next)); } catch { /* Session-only when storage is unavailable. */ }
  };
  const setDock = (value: Dock) => onLayout?.(value === 'left' ? 'side' : value);
  const resizeHandlers = {
    onPointerDown(e: PointerEvent<HTMLElement>) { e.preventDefault(); gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, size }; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove(e: PointerEvent<HTMLElement>) { const g = gesture.current; if (!g || g.id !== e.pointerId) return; setSize(g.size + (horizontal ? e.clientY - g.y : (e.clientX - g.x) * (dock === 'right' ? -1 : 1))); },
    onPointerUp() { gesture.current = null; }, onPointerCancel() { gesture.current = null; }, onLostPointerCapture() { gesture.current = null; },
  };
  const moveHandlers = {
    onPointerDown(e: PointerEvent<HTMLButtonElement>) { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pending.current = dock; setTarget(dock); },
    onPointerMove(e: PointerEvent<HTMLButtonElement>) { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const rect = stage.current?.getBoundingClientRect(); if (!rect) return; const next = e.clientY - rect.top < rect.height * .28 ? 'top' : e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'; pending.current = next; setTarget(next); },
    onPointerUp() { if (pending.current) setDock(pending.current); pending.current = null; setTarget(null); },
    onPointerCancel() { pending.current = null; setTarget(null); }, onLostPointerCapture() { pending.current = null; setTarget(null); },
  };
  function resizeKey(e: KeyboardEvent) {
    if (e.key === 'Home') { e.preventDefault(); setSize(minimum); }
    else if (e.key === 'End') { e.preventDefault(); setSize(maximum); }
    else if (['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setSize(size + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 16 : -16)); }
  }
  function reset() { setDock('top'); setSizes({ top: 190, side: 300 }); try { localStorage.removeItem('bc-camera-row-size'); localStorage.removeItem('bc-camera-side-size'); } catch { /* Session-only. */ } }
  return { stage, dock, size, minimum, maximum, target, setDock, reset, moveHandlers, resizeHandlers, resizeKey };
}
