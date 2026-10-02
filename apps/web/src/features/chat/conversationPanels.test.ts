import { afterEach, expect, it, vi } from 'vitest';
import { openConversationPanel, subscribeConversationPanels } from './conversationPanels';

afterEach(() => vi.unstubAllGlobals());

it('routes panel requests only to the matching mounted conversation', () => {
  vi.stubGlobal('window', new EventTarget());
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeConversationPanels('first', first);
  const stopSecond = subscribeConversationPanels('second', second);
  openConversationPanel('first', 'pins');
  expect(first).toHaveBeenCalledExactlyOnceWith('pins');
  expect(second).not.toHaveBeenCalled();
  openConversationPanel('second', 'threads');
  expect(second).toHaveBeenCalledExactlyOnceWith('threads');
  stopFirst();
  openConversationPanel('first', 'threads');
  expect(first).toHaveBeenCalledTimes(1);
  stopSecond();
});

it('ignores malformed panel events without changing the conversation', () => {
  vi.stubGlobal('window', new EventTarget());
  const listener = vi.fn();
  const stop = subscribeConversationPanels('room', listener);
  window.dispatchEvent(new CustomEvent('bc-conversation-panel', { detail: { roomId: 'room', panel: 'unknown' } }));
  window.dispatchEvent(new CustomEvent('bc-conversation-panel'));
  expect(listener).not.toHaveBeenCalled();
  stop();
});
