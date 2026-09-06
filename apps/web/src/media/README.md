# Browser media engine

This directory is a React-independent WebRTC mesh engine. Create a
`RoomWebSocketSignaling`, connect its peer and signal events to a `MediaEngine`,
then subscribe to `local-track`, `remote-track`, `remote-track-removed`,
`peer-state`, and `error` events from React.

```ts
const signaling = new RoomWebSocketSignaling(
  user.id,
  `/api/v1/rooms/${room.id}/ws`,
);
const media = new MediaEngine({
  signaling,
  ice: { mode: 'direct-preferred', iceServers },
});

signaling.addEventListener(
  'signal',
  (event) => void media.handleSignal(event.detail),
);
signaling.addEventListener('peers', (event) =>
  event.detail.peerIds.forEach((id) => media.addPeer(id)),
);
signaling.addEventListener('peer-joined', (event) =>
  media.addPeer(event.detail.peerId),
);
signaling.addEventListener('peer-left', (event) =>
  media.removePeer(event.detail.peerId),
);
await signaling.connect();
await media.captureUserMedia({
  noiseSuppression: true,
  echoCancellation: true,
});
```

The signaling server relays `offer`, `answer`, `ice-candidate`, and
`track-metadata` frames and adds `from`. Metadata is required because WebRTC
only identifies tracks as audio or video; it cannot distinguish camera from
screen or microphone from captured system audio. Negotiation follows the
WebRTC perfect-negotiation pattern, with polite/impolite roles derived
deterministically from peer IDs.

`direct-only` excludes TURN relay candidates while retaining host, server-reflexive,
and peer-reflexive candidates, including those discovered through configured STUN
servers. It can fail behind restrictive NATs. `direct-preferred` permits every
configured route, including TURN. WebRTC does not provide a portable API to prefer
non-relay candidates while retaining relay fallback, so the browser's ICE agent
chooses the candidate pair.

`setQuality()` applies optional audio/video bitrate, frame-rate, and resolution-scale
ceilings. Audio defaults to a 256 kbps ceiling and capture requests stereo where
the browser and device support it. `getStats(peerId)` reports measured inbound/outbound bitrate after the
second sample, resolution, frame rate, loss/jitter, round-trip time, and the
selected ICE route. Missing values mean the browser did not publish that stat.

Browser capture constraints expose basic noise suppression, echo cancellation,
and automatic gain control when the device/browser supports them. The optional
`AudioLeveler` performs simple RMS-based playback leveling in Web Audio. It is
not Krisp or GPU acceleration. `denoiser: "rnnoise"` runs the open RNNoise model
in an AudioWorklet/WASM graph and disables browser noise suppression to avoid
double processing. `denoiser: "speex"` similarly runs the SpeexDSP preprocessor
locally in an AudioWorklet/WASM graph. The packaged Speex worklet does not expose
a suppression-strength control. `denoiser: "nvidia"` uses the native desktop SDK
pipeline and falls back explicitly to RNNoise; browsers resolve stale NVIDIA
preferences to standard processing without native IPC. Krisp is deferred.

Recording uses one `MediaRecorder` per currently selected local and remote track.
All recorders share a monotonic epoch, and `manifest.json` records each actual
start offset, duration, MIME type, size, peer, and logical source. Starting or
ending a call track does not silently alter an active recording; start a new
session to capture a changed track set. Container timestamps and encoder startup
may differ slightly between files, so downstream playback should align them by
the manifest offsets. Bounded instant replay is explicitly reported as
unsupported. Codec/container support is browser-dependent.

Call `media.dispose()` and `signaling.close()` on room exit. This closes peer
connections, removes remote state, and stops owned local capture tracks.
