export function readRecordingQuality() {
  let value = 20;
  try {
    value = Number(localStorage.getItem('bc-recording-mbps') ?? 20);
  } catch {
    /* use defaults */
  }
  return {
    screenVideoBitsPerSecond:
      ([10, 20, 40, 80].includes(value) ? value : 20) * 1_000_000,
  };
}
