import { describe, expect, it } from "vitest";
import { findTrackDescriptor, isRelayCandidate } from "./utils";

describe("ICE route filtering", () => {
  it("rejects only TURN relay routes for direct-only mode", () => {
    expect(isRelayCandidate({ candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host generation 0" })).toBe(false);
    expect(isRelayCandidate({ candidate: "candidate:2 1 udp 1 203.0.113.3 5001 typ srflx raddr 10.0.0.2 rport 5000" })).toBe(false);
    expect(isRelayCandidate({ candidate: "candidate:3 1 udp 1 198.51.100.4 5002 typ prflx" })).toBe(false);
    expect(isRelayCandidate({ candidate: "candidate:4 1 udp 1 192.0.2.8 5003 typ relay raddr 203.0.113.3 rport 5001" })).toBe(true);
  });
});

describe("remote track metadata", () => {
  const descriptors = [
    { source: "camera" as const, trackId: "camera-track", streamId: "camera-stream", mediaKind: "video" as const, enabled: true },
    { source: "screen" as const, trackId: "screen-track", streamId: "screen-stream", mediaKind: "video" as const, enabled: true },
  ];

  it("uses the exact track id when browsers preserve it", () => {
    expect(findTrackDescriptor(descriptors, "screen-track", [])?.source).toBe("screen");
  });

  it("falls back to the negotiated stream id when a browser rewrites track ids", () => {
    expect(findTrackDescriptor(descriptors, "rewritten-id", ["camera-stream"])?.source).toBe("camera");
  });
});
