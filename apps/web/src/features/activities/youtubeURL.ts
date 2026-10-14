/** A local hint only; the API still validates URLs and channel permissions. */
export function youtubeWatchURL(raw: string): string | undefined {
  const value = raw.trim();
  if (
    value.length > 2048 ||
    !/^https:\/\/(?:youtu\.be|(?:(?:www|m)\.)?youtube\.com)\//i.test(value)
  )
    return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return;
    const parts = url.pathname.split('/');
    const id =
      url.hostname === 'youtu.be'
        ? parts.length === 2
          ? parts[1]
          : undefined
        : url.pathname === '/watch'
          ? url.searchParams.get('v')
          : parts.length === 3 && parts[1] === 'shorts'
            ? parts[2]
            : undefined;
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id))
      return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    /* Ordinary chat text and unsupported links have no watch action. */
  }
}
