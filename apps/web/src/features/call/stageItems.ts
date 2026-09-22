
export type GalleryLayout = 'adaptive' | 'grid' | 'focus' | 'all';
export const galleryLayouts: readonly GalleryLayout[] = ['adaptive', 'grid', 'focus', 'all'];

/** One screen share or camera that can be put on the main stage. */
export type StageItem = {
  key: string;
  kind: 'screen' | 'camera';
  name: string;
  track: MediaStreamTrack;
  self?: boolean;
  /** The sender fell back to re-encoding this screen through the call. */
  reencoded?: boolean;
};

export type ScreenShare = {
  id: string;
  name: string;
  track: MediaStreamTrack;
  reencoded: boolean;
};

export type CameraParticipant = {
  id: string;
  name: string;
  track?: MediaStreamTrack;
  self: boolean;
};

export const screenKey = (id: string) => `screen:${id}`;
export const cameraKey = (id: string) => `camera:${id}`;
export const shareIdOf = (key: string) => key.slice('screen:'.length);

/** Everything that could be shown on the stage, screens first. */
export function buildStageItems(
  shares: ScreenShare[],
  cameras: CameraParticipant[],
): StageItem[] {
  return [
    ...shares.map((share) => ({
      key: screenKey(share.id),
      kind: 'screen' as const,
      name: share.name,
      track: share.track,
      self: share.id === 'local',
      reencoded: share.reencoded,
    })),
    ...cameras
      .filter((camera): camera is CameraParticipant & { track: MediaStreamTrack } =>
        Boolean(camera.track),
      )
      .map((camera) => ({
        key: cameraKey(camera.id),
        kind: 'camera' as const,
        name: camera.self ? 'Your camera' : camera.name,
        track: camera.track,
        self: camera.self,
      })),
  ];
}
