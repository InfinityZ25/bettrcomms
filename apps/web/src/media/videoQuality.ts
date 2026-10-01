/**
 * Codec order and bitrate budgets for call video sent by the browser.
 *
 * Without a stated preference each pair of devices ended up on whichever codec
 * the offering browser listed first: VP8 when Chrome offered, H.264 when
 * Safari did. The same call could software-encode on a phone one day and
 * hardware-encode the next. Every client now states one order.
 */

/**
 * H.264 first, because phones and most laptops encode and decode it in
 * hardware and the native senders already use it; VP8 next, which every
 * browser can do in software, so a build without H.264 still connects.
 * Retransmission and error-correction entries keep their relative order at
 * the end, where the browser expects to find them.
 */
export function preferredVideoCodecs<T extends { mimeType: string; sdpFmtpLine?: string }>(codecs: readonly T[]): T[] {
  const rank = (codec: T) => {
    const mime = codec.mimeType.toLowerCase();
    if (mime === 'video/h264') {
      const format = codec.sdpFmtpLine ?? '';
      // Mode 1 is the packetization every WebRTC stack implements.
      if (!/packetization-mode=1/.test(format)) return 3;
      const profile = /profile-level-id=([0-9a-f]{4})/i.exec(format)?.[1].toLowerCase();
      // Constrained Baseline is the one profile every decoder accepts.
      return profile === '42e0' ? 0 : profile === '4200' ? 1 : 2;
    }
    if (mime === 'video/vp8') return 4;
    if (mime === 'video/vp9') return 5;
    if (mime === 'video/av1') return 6;
    return 7;
  };
  return codecs
    .map((codec, index) => ({ codec, index, order: rank(codec) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ codec }) => codec);
}

/**
 * The most a camera of this size is worth sending, in bits per second.
 *
 * Cameras used to share the screen-share ceiling (20 Mbps by default), which
 * is several times what a camera picture can use and, multiplied by every
 * person in a call, more than most uplinks have.
 */
export function cameraBitrateCeiling(settings: { width?: number; height?: number; frameRate?: number }): number {
  const pixels = (settings.width ?? 1280) * (settings.height ?? 720);
  const base =
    pixels <= 640 * 360 ? 700_000
    : pixels <= 640 * 480 ? 1_000_000
    : pixels <= 1280 * 720 ? 2_500_000
    : pixels <= 1920 * 1080 ? 4_000_000
    : 6_000_000;
  return (settings.frameRate ?? 30) > 35 ? Math.round(base * 1.4) : base;
}

/**
 * One viewer's share of a ceiling.
 *
 * A call sends each viewer its own encoded copy, so the uplink carries the
 * ceiling once per viewer. Up to two viewers get it in full; beyond that the
 * total is held at twice the ceiling and divided.
 */
export function perViewerBitrate(ceiling: number, viewers: number): number {
  return viewers <= 2 ? ceiling : Math.round((ceiling * 2) / viewers);
}
