import { expect, it } from 'vitest';
import { cameraBitrateCeiling, perViewerBitrate, preferredVideoCodecs } from './videoQuality';

const codec = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, sdpFmtpLine });

it('puts decodable-everywhere H.264 first, then VP8, and keeps repair codecs last', () => {
  // Chrome's order: VP8 first, H.264 variants later, rtx entries interleaved.
  const chrome = [
    codec('video/VP8'), codec('video/rtx', 'apt=96'), codec('video/VP9', 'profile-id=0'),
    codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'),
    codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f'),
    codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'),
    codec('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f'),
    codec('video/AV1'), codec('video/red'), codec('video/ulpfec'),
  ];
  expect(preferredVideoCodecs(chrome).map((entry) => `${entry.mimeType} ${entry.sdpFmtpLine ?? ''}`.trim())).toEqual([
    'video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
    'video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
    'video/H264 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
    'video/VP8', 'video/VP9 profile-id=0', 'video/AV1',
    'video/rtx apt=96', 'video/red', 'video/ulpfec',
  ]);
});

it('leaves a build without H.264 on VP8', () => {
  const chromium = [codec('video/VP9'), codec('video/VP8'), codec('video/rtx')];
  expect(preferredVideoCodecs(chromium).map((entry) => entry.mimeType)).toEqual(['video/VP8', 'video/VP9', 'video/rtx']);
});

it('sizes a camera ceiling to its picture, not to the screen-share ceiling', () => {
  expect(cameraBitrateCeiling({ width: 640, height: 480, frameRate: 15 })).toBe(1_000_000);
  expect(cameraBitrateCeiling({ width: 1280, height: 720, frameRate: 30 })).toBe(2_500_000);
  // A portrait phone camera is the same picture turned.
  expect(cameraBitrateCeiling({ width: 1080, height: 1920, frameRate: 30 })).toBe(4_000_000);
  expect(cameraBitrateCeiling({ width: 1280, height: 720, frameRate: 60 })).toBe(3_500_000);
  expect(cameraBitrateCeiling({})).toBe(2_500_000);
});

it('holds the uplink at twice the ceiling however many people are watching', () => {
  expect(perViewerBitrate(2_500_000, 1)).toBe(2_500_000);
  expect(perViewerBitrate(2_500_000, 2)).toBe(2_500_000);
  expect(perViewerBitrate(2_500_000, 4)).toBe(1_250_000);
  expect(perViewerBitrate(20_000_000, 5) * 5).toBe(40_000_000);
});
