import { NvidiaSocketBridge } from './nvidiaSocketBridge';
let socket: WebSocket | undefined;
let port: MessagePort | undefined;
let bridge: NvidiaSocketBridge | undefined;
let ready = false;
let failed = false;
let frameSamples = 0;
let initializationTimer: ReturnType<typeof setTimeout> | undefined;
let displayName = 'NVIDIA';
function fail(reason: string) {
  if (failed) return;
  failed = true;
  clearTimeout(initializationTimer);
  bridge?.dispose();
  port?.close();
  socket?.close();
  self.postMessage({ type: 'failure', reason });
}
self.onmessage = ({ data }) => {
  if (data.type === 'initialize' && !socket) {
    const session = data.session;
    if (data.displayName === 'DeepFilterNet') displayName = data.displayName;
    if (
      !Number.isInteger(session.port) ||
      session.port < 1 ||
      session.port > 65535 ||
      typeof session.token !== 'string' ||
      !session.token ||
      !Number.isInteger(session.frameSamples) ||
      session.frameSamples < 1 ||
      session.frameSamples > 960
    ) {
      fail(`${displayName} returned an invalid audio connection`);
      return;
    }
    frameSamples = session.frameSamples;
    initializationTimer = setTimeout(
      () => fail(`${displayName} audio connection timed out`),
      5000,
    );
    socket = new WebSocket(`ws://127.0.0.1:${session.port}/`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () =>
      socket!.send(JSON.stringify({ token: session.token }));
    socket.onerror = () => fail(`${displayName} audio connection failed`);
    socket.onclose = () => fail(`${displayName} audio connection closed`);
    socket.onmessage = ({ data: message }) => {
      if (!ready) {
        try {
          if (
            typeof message !== 'string' ||
            JSON.parse(message).type !== 'ready'
          )
            throw new Error();
          ready = true;
          clearTimeout(initializationTimer);
          self.postMessage({ type: 'ready' });
        } catch {
          fail(`${displayName} audio connection was not accepted`);
        }
      } else if (bridge && message instanceof ArrayBuffer) {
        bridge.receive(message);
        if (bridge.processedFrames % 25 === 0)
          self.postMessage({
            type: 'diagnostics',
            processedFrames: bridge.processedFrames,
          });
      } else
        fail(`${displayName} audio connection returned an unexpected message`);
    };
  } else if (data.type === 'attach' && ready && socket && !port) {
    port = data.port;
    bridge = new NvidiaSocketBridge(
      socket,
      port!,
      frameSamples,
      fail,
      displayName,
    );
    port!.onmessage = ({ data: message }) => {
      if (message.type === 'frame') bridge?.submit(message);
      else if (message.type === 'playout')
        self.postMessage({
          type: 'playout',
          underruns: message.underruns,
          droppedFrames: message.droppedFrames,
          bufferMs: message.bufferMs,
        });
      else if (message.type === 'failure')
        fail(message.reason ?? 'NVIDIA audio worklet failed');
    };
    port!.start();
  }
};
