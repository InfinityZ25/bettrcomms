export type InboxTab = 'saved' | 'reminders';
let pending: InboxTab | undefined;
export function openPersonalInbox(tab: InboxTab = 'reminders') {
  pending = tab;
  window.dispatchEvent(new CustomEvent('bc-personal-inbox', { detail: tab }));
}
export function consumeInboxRequest() {
  const tab = pending;
  pending = undefined;
  return tab;
}
