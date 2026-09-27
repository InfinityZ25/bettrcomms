export function openMessageSearch(roomId?: string) {
  window.dispatchEvent(
    new CustomEvent('bc-message-search', { detail: roomId }),
  );
}
