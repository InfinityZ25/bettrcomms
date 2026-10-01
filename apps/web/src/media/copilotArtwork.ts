import type { CopilotMark } from './visualCopilot';

export async function drawCopilotArtwork(mark: CopilotMark, size: number, cardWidth: number, participant: string) {
  const canvas = document.createElement('canvas');
  canvas.width = mark.kind === 'ping' ? 180 : cardWidth;
  canvas.height = mark.kind === 'ping' ? 180 : Math.min(340, Math.round(cardWidth * 9 / 16) + 48);
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not draw the indication.');
    const name = participant.slice(0, 28);
    if (mark.kind === 'ping') {
      ctx.strokeStyle = mark.laser ? '#fff' : '#d2ff88'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(90, 90, mark.laser ? 6 : size / 2, 0, Math.PI * 2);
      if (mark.laser) { ctx.fillStyle = '#ff665f'; ctx.fill(); }
      ctx.stroke();
      ctx.fillStyle = '#e4ffcb'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(name, 90, 90 + size / 2 + 20, 170);
    } else {
      const image = new Image(); image.src = mark.image!;
      try {
        await image.decode();
        if (image.naturalWidth > 640 || image.naturalHeight > 640) throw new Error('Invalid marked capture dimensions.');
        ctx.fillStyle = '#17211a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#c9f18d'; ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
        ctx.fillStyle = '#e4ffcb'; ctx.font = '13px sans-serif'; ctx.fillText(`${name} pointed here`, 8, 18, canvas.width - 16);
        const ratio = Math.min((canvas.width - 16) / image.naturalWidth, (canvas.height - 52) / image.naturalHeight);
        const width = image.naturalWidth * ratio, height = image.naturalHeight * ratio;
        ctx.drawImage(image, (canvas.width - width) / 2, 26, width, height);
        ctx.fillStyle = '#b6c4b5'; ctx.font = '11px sans-serif';
        ctx.fillText('Captured frame · dismiss in BetterComms', 8, canvas.height - 10, canvas.width - 16);
      } finally { image.src = ''; }
    }
    return { pixels: new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer), width: canvas.width, height: canvas.height };
  } finally { canvas.width = 0; canvas.height = 0; }
}
