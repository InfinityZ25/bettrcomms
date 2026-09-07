/** Deliberate allowlist: never include SDP, addresses, candidates, URLs or device IDs. */
export async function screenReceiverDiagnostics(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  const rows = [...report.values()];
  const video = rows.find(r => r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'video');
  const codec = rows.find(r => r.id === video?.codecId);
  const transport = rows.find(r => r.type === 'transport' && r.selectedCandidatePairId);
  const pair = rows.find(r => r.id === transport?.selectedCandidatePairId)
    ?? rows.find(r => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated);
  const local = rows.find(r => r.id === pair?.localCandidateId);
  const remote = rows.find(r => r.id === pair?.remoteCandidateId);
  const numeric = (row: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.flatMap(key => typeof row?.[key] === 'number' && Number.isFinite(row[key]) ? [[key, row[key]]] : []));
  return {
    connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState, signalingState: pc.signalingState,
    negotiation: {
      offeredProfiles: [...new Set((pc.remoteDescription?.sdp ?? '').match(/profile-level-id=[0-9a-f]{6}/gi) ?? [])],
      answeredProfiles: [...new Set((pc.localDescription?.sdp ?? '').match(/profile-level-id=[0-9a-f]{6}/gi) ?? [])],
      videoRejected: /^m=video 0 /m.test(pc.localDescription?.sdp ?? ''),
    },
    video: numeric(video, ['bytesReceived','packetsReceived','packetsLost','framesReceived','framesDecoded','framesDropped','keyFramesDecoded','frameWidth','frameHeight','framesPerSecond','jitter','totalDecodeTime','pliCount','firCount','nackCount','freezeCount','totalFreezesDuration']),
    decoder: typeof video?.decoderImplementation === 'string' && /^[a-z0-9 _().+-]{1,120}$/i.test(video.decoderImplementation) ? video.decoderImplementation : undefined,
    powerEfficientDecoder: typeof video?.powerEfficientDecoder === 'boolean' ? video.powerEfficientDecoder : undefined,
    codec: codec ? { mimeType: codec.mimeType, clockRate: codec.clockRate, ...h264Parameters(codec.sdpFmtpLine) } : undefined,
    route: pair ? { state: pair.state, localType: local?.candidateType, remoteType: remote?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol, ...numeric(pair, ['currentRoundTripTime','bytesReceived','bytesSent','requestsSent','responsesReceived']) } : undefined,
    tracks: pc.getReceivers().map(r => ({ kind: r.track.kind, enabled: r.track.enabled, muted: r.track.muted, readyState: r.track.readyState })),
  };
}
export function h264Parameters(fmtp?: string) {
  return { profileLevelId: /(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i.exec(fmtp ?? '')?.[1], packetizationMode: /(?:^|;)\s*packetization-mode=([01])(?:;|$)/.exec(fmtp ?? '')?.[1] };
}
export function videoCapabilities() {
  return (globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs ?? []).map(c => ({ mimeType: c.mimeType, clockRate: c.clockRate, ...h264Parameters(c.sdpFmtpLine) }));
}
