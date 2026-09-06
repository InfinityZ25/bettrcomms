import type { TrackDescriptor } from "./types";

export function isRelayCandidate(candidate: RTCIceCandidateInit): boolean {
  return (candidate.candidate ?? "").includes(" typ relay ");
}

export function findTrackDescriptor(
  descriptors: Iterable<TrackDescriptor>,
  trackId: string,
  streamIds: readonly string[],
): TrackDescriptor | undefined {
  const values = [...descriptors];
  return values.find((descriptor) => descriptor.trackId === trackId)
    ?? values.find((descriptor) => descriptor.streamId && streamIds.includes(descriptor.streamId));
}
