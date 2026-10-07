import { afterEach, expect, test, vi } from 'vitest';
import { observeCallStage } from './useCallLayout';

afterEach(() => vi.unstubAllGlobals());

test('restored call stage accepts its dimensions and ignores callbacks from the removed stage', () => {
  const observers: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
  });
  const beforeNavigation = {} as HTMLDivElement;
  const afterNavigation = {} as HTMLDivElement;
  const onExtent = vi.fn();
  const report = (index: number, target: HTMLDivElement, width: number, height: number) => {
    observers[index].callback(
      [{
        target,
        contentRect: {
          x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height,
          toJSON: () => ({ width, height }),
        },
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      } satisfies ResizeObserverEntry],
      observers[index] as unknown as ResizeObserver,
    );
  };

  const detachFirst = observeCallStage(beforeNavigation, onExtent);
  report(0, beforeNavigation, 576, 768);
  expect(onExtent).toHaveBeenLastCalledWith({ width: 576, height: 768 });
  detachFirst();
  expect(observers[0].disconnect).toHaveBeenCalledOnce();

  const detachRestored = observeCallStage(afterNavigation, onExtent);
  expect(observers[1].observe).toHaveBeenCalledWith(afterNavigation);
  report(1, afterNavigation, 576, 740);
  expect(onExtent).toHaveBeenLastCalledWith({ width: 576, height: 740 });
  // A queued zero-size delivery from the detached node must not clamp resizing.
  report(0, beforeNavigation, 0, 0);
  expect(onExtent).toHaveBeenCalledTimes(2);
  expect(onExtent).toHaveBeenLastCalledWith({ width: 576, height: 740 });

  detachRestored();
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  report(1, afterNavigation, 0, 0);
  expect(onExtent).toHaveBeenCalledTimes(2);
});
