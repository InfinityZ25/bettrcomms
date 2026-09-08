export interface OverlayCamera {
  id: string;
  name: string;
  track: MediaStreamTrack;
  speaking?: boolean;
  muted?: boolean;
  deafened?: boolean;
}

/** Small, view-only composite. Never reacquires a device or modifies a source. */
export class CameraOverlayCanvas {
  private readonly canvas = document.createElement('canvas');
  private readonly context = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private readonly videos = new Map<string, { track: MediaStreamTrack; video: HTMLVideoElement }>();

  render(cameras: OverlayCamera[], width: number, height: number): Uint8Array {
    const visible = cameras.filter(camera => camera.track.readyState === 'live' && camera.track.enabled).slice(0, 4);
    const ids = new Set(visible.map(camera => camera.id));
    for (const [id, entry] of this.videos) {
      if (!ids.has(id) || visible.find(camera => camera.id === id)?.track !== entry.track) {
        entry.video.pause();
        entry.video.srcObject = null;
        this.videos.delete(id);
      }
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    const rows = Math.max(1, visible.length);
    const tileHeight = Math.floor(height / rows);
    if (!visible.length) {
      ctx.fillStyle = '#141b17';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#c1d1c5';
      ctx.font = '14px sans-serif';
      ctx.fillText('Waiting for cameras', 16, Math.min(height - 12, 32));
    }
    visible.forEach((camera, index) => {
      let entry = this.videos.get(camera.id);
      if (!entry) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = new MediaStream([camera.track]);
        void video.play().catch(() => {});
        entry = { video, track: camera.track };
        this.videos.set(camera.id, entry);
      }
      const y = index * tileHeight;
      const h = tileHeight - (index < rows - 1 ? 6 : 0);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, y, width, h, 10);
      ctx.clip();
      ctx.fillStyle = '#141b17';
      ctx.fillRect(0, y, width, h);
      const video = entry.video;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight && !camera.track.muted) {
        const scale = Math.min(width / video.videoWidth, h / video.videoHeight);
        const w = video.videoWidth * scale;
        const vh = video.videoHeight * scale;
        ctx.drawImage(video, (width - w) / 2, y + (h - vh) / 2, w, vh);
      }
      ctx.fillStyle = '#07100cbb';
      ctx.fillRect(0, y + h - 27, width, 27);
      ctx.fillStyle = '#f2f8f4';
      ctx.font = '12px sans-serif';
      const state = camera.deafened ? ' · Deafened' : camera.muted ? ' · Muted' : '';
      ctx.fillText(camera.name.slice(0, 40) + state, 9, y + h - 9, width - 18);
      if (camera.speaking && !camera.muted && !camera.deafened) {
        ctx.strokeStyle = '#bcec8c';
        ctx.lineWidth = 4;
        ctx.strokeRect(1, y + 1, width - 2, h - 2);
      }
      ctx.restore();
    });
    return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
  }

  dispose() {
    for (const { video } of this.videos.values()) { video.pause(); video.srcObject = null; }
    this.videos.clear();
    this.canvas.width = this.canvas.height = 0;
  }
}
