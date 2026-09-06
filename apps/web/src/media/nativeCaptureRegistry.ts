// Kept separate from the transport so hot replacement of transport code cannot
// split the preview/recorder association across different module instances.
const previews: WeakMap<MediaStreamTrack, string> = import.meta.hot
  ? (import.meta.hot.data.previews ??= new WeakMap<MediaStreamTrack, string>())
  : new WeakMap<MediaStreamTrack, string>();
export const registerNativeScreenTrack = (
  track: MediaStreamTrack,
  sessionId: string,
) => previews.set(track, sessionId);
export const nativeScreenSessionForTrack = (track: MediaStreamTrack) =>
  previews.get(track);
