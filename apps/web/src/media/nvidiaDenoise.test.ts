import { describe, expect, it, vi } from 'vitest';
import { NvidiaSocketBridge } from './nvidiaSocketBridge';

const frame = (id: number, values = [0.1, -0.1]) => ({
  type: 'frame' as const,
  id,
  samples: new Float32Array(values).buffer,
});
function setup() {
  const socket = { send: vi.fn(), readyState: 1, bufferedAmount: 0 };
  const port = { postMessage: vi.fn() };
  const failed = vi.fn();
  const bridge = new NvidiaSocketBridge(socket, port, 2, failed);
  return { socket, port, failed, bridge };
}
describe('NVIDIA worker audio transport', () => {
  it('serializes binary frames and transfers results directly to the worklet', () => {
    const { socket, port, bridge } = setup();
    bridge.submit(frame(0));
    bridge.submit(frame(1));
    expect(socket.send).toHaveBeenCalledTimes(1);
    const output = new Float32Array([0.01, -0.01]).buffer;
    bridge.receive(output);
    expect(port.postMessage).toHaveBeenCalledWith(
      { type: 'processed', id: 0, samples: output },
      [output],
    );
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(bridge.processedFrames).toBe(1);
    bridge.dispose();
  });
  it('bounds pending audio when native processing stalls', () => {
    const { bridge, failed, socket } = setup();
    for (let id = 0; id < 25; id++) bridge.submit(frame(id));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    bridge.receive(new Float32Array(2).buffer);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
  it('ignores late output after disposal', () => {
    const { bridge, port } = setup();
    bridge.submit(frame(0));
    bridge.dispose();
    bridge.receive(new Float32Array(2).buffer);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
  it('rejects malformed native output without sending it to playback', () => {
    const { bridge, port, failed } = setup();
    bridge.submit(frame(0));
    bridge.receive(new Float32Array([NaN, 0]).buffer);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
  it('fails a hung native request once and stops queuing', () => {
    vi.useFakeTimers();
    const { bridge, failed } = setup();
    bridge.submit(frame(0));
    vi.advanceTimersByTime(251);
    bridge.submit(frame(1));
    expect(failed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
