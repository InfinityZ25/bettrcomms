export const quickAccessEvent = 'bc-quick-access';
export function openQuickAccess() {
  window.dispatchEvent(new Event(quickAccessEvent));
}
