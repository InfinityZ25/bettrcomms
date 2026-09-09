import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/**
 * Fullscreen for the call workspace, and the controls that fade with it.
 *
 * Only real pointer movement counts: a pointermove fired at an unchanged
 * position (which browsers do on scroll and on layout changes) would otherwise
 * keep the controls awake forever.
 */
export function useImmersiveControls(
  workspace: RefObject<HTMLDivElement | null>,
  onError: (message: string) => void,
) {
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef({ x: Number.NaN, y: Number.NaN });

  useEffect(() => {
    const update = () => {
      setFullscreen(
        document.fullscreenElement === workspace.current && Boolean(workspace.current),
      );
      setControlsVisible(true);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [workspace]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const reveal = () => {
    setControlsVisible(true);
    if (timer.current) clearTimeout(timer.current);
    if (fullscreen) timer.current = setTimeout(() => setControlsVisible(false), 2400);
  };

  useEffect(() => {
    if (!fullscreen) return;
    reveal();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fullscreen]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = lastPointer.current;
    if (previous.x === event.clientX && previous.y === event.clientY) return;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    reveal();
  };

  const toggleFullscreen = () => {
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : workspace.current?.requestFullscreen();
    void action?.catch((error: Error) => onError(error.message));
  };

  /** Runs an action that must not happen behind a fullscreen surface. */
  const leavingFullscreen = (action: () => void) => {
    if (document.fullscreenElement) void document.exitFullscreen().then(action);
    else action();
  };

  return {
    fullscreen,
    controlsVisible,
    reveal,
    onPointerMove,
    toggleFullscreen,
    leavingFullscreen,
  };
}
