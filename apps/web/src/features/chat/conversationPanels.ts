export type ConversationPanel = 'pins' | 'threads';
const eventName = 'bc-conversation-panel';

export function openConversationPanel(roomId: string, panel: ConversationPanel) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: { roomId, panel } }));
}

export function subscribeConversationPanels(roomId: string, open: (panel: ConversationPanel) => void) {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<{ roomId?: string; panel?: string }>).detail;
    if (detail?.roomId === roomId && (detail.panel === 'pins' || detail.panel === 'threads')) open(detail.panel);
  };
  window.addEventListener(eventName, receive);
  return () => window.removeEventListener(eventName, receive);
}
