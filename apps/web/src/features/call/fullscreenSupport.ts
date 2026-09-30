/** Some WebKit builds omit the API entirely, rather than returning false. */
export function canUseFullscreen(document: {
  fullscreenEnabled?: boolean;
  documentElement?: { requestFullscreen?: unknown };
}): boolean {
  return (
    document.fullscreenEnabled === true &&
    typeof document.documentElement?.requestFullscreen === 'function'
  );
}
