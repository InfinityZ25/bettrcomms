import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;

/**
 * Pointer-anchored zoom and drag-to-pan over a fixed viewport.
 *
 * Zoom and pan are mirrored into refs so wheel and pointer handlers read the
 * current value without re-subscribing, and the pan is re-constrained whenever
 * the viewport resizes so the content can never be dragged off screen.
 */
export function useZoomPan(resetKey: unknown) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);

  const commitPan = (next: { x: number; y: number }) => {
    panRef.current = next;
    setPan(next);
  };
  const constrainPan = (next: { x: number; y: number }, scale: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || scale <= 1) return { x: 0, y: 0 };
    const maxX = (rect.width * (scale - 1)) / 2;
    const maxY = (rect.height * (scale - 1)) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  };

  const reset = () => {
    zoomRef.current = 1;
    setZoom(1);
    commitPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [resetKey]);

  useEffect(() => {
    const target = viewport.current;
    if (!target || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      commitPan(constrainPan(panRef.current, zoomRef.current)),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const zoomAt = (requested: number, clientX?: number, clientY?: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requested));
    const previous = zoomRef.current;
    if (Math.abs(next - previous) < 0.0001) return;
    const rect = viewport.current?.getBoundingClientRect();
    const point =
      rect && clientX !== undefined && clientY !== undefined
        ? { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
        : { x: 0, y: 0 };
    const ratio = next / previous;
    commitPan(
      constrainPan(
        {
          x: point.x - ratio * (point.x - panRef.current.x),
          y: point.y - ratio * (point.y - panRef.current.y),
        },
        next,
      ),
    );
    zoomRef.current = next;
    setZoom(next);
  };

  const step = (delta: number) => zoomAt(zoomRef.current + delta);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
    setDragging(false);
  };

  /** Spread onto the viewport element; it owns wheel zoom and drag panning. */
  const viewportHandlers = {
    onWheel: (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const pixels =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoomAt(zoomRef.current * Math.exp(-pixels * 0.00125), event.clientX, event.clientY);
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (zoomRef.current <= 1 || event.button !== 0) return;
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        px: panRef.current.x,
        py: panRef.current.y,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      commitPan(
        constrainPan(
          {
            x: drag.current.px + event.clientX - drag.current.x,
            y: drag.current.py + event.clientY - drag.current.y,
          },
          zoomRef.current,
        ),
      );
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };

  return { zoom, pan, dragging, viewport, viewportHandlers, step, reset };
}
