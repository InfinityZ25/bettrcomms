import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Fullscreen is a lean-back posture, so it gets the shorter fuse. */
const IDLE_FULLSCREEN = 2400;
const IDLE_WINDOWED = 3600;

/**
 * Fullscreen for the call workspace, and the controls that come and go with the
 * pointer.
 *
 * The controls leave the screen once the mouse has been still for a moment and
 * come back the instant it moves, in a window as much as in fullscreen: a call
 * is something you watch, and a bar of buttons that is always there is chrome
 * sitting on top of the only thing anybody came to look at.
 *
 * Only real pointer movement counts: a pointermove fired at an unchanged
 * position (which browsers do on scroll and on layout changes) would otherwise
 * keep the controls awake forever. And nothing is hidden until a mouse has
 * actually been seen — a touch screen fires no movement to bring them back
 * with, so on a tablet the controls simply stay.
 */
export function useImmersiveControls(
  workspace: RefObject<HTMLDivElement | null>,
  onError: (message: string) => void,
) {
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef({ x: Number.NaN, y: Number.NaN });
  const mouseSeen = useRef(false);
  // Read inside a timer callback, so it has to be a ref rather than the state.
  const inFullscreen = useRef(fullscreen);
  inFullscreen.current = fullscreen;

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

  /** Show the controls, and start the clock that takes them away again. */
  const reveal = () => {
    setControlsVisible(true);
    if (timer.current) clearTimeout(timer.current);
    if (!mouseSeen.current) return;
    timer.current = setTimeout(
      () => setControlsVisible(false),
      inFullscreen.current ? IDLE_FULLSCREEN : IDLE_WINDOWED,
    );
  };

  useEffect(() => {
    reveal();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fullscreen]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = lastPointer.current;
    if (previous.x === event.clientX && previous.y === event.clientY) return;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (event.pointerType !== 'touch') mouseSeen.current = true;
    reveal();
  };

  /** A tap brings them back on a touch screen, where there is no movement to. */
  const onPointerDown = () => reveal();

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
    onPointerDown,
    toggleFullscreen,
    leavingFullscreen,
  };
}
