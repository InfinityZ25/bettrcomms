import { useRef, useState } from 'react';
import { useMountEffect } from '@/hooks/useMountEffect';
import {
  conversationSnapshot,
  jumpToMessage,
  loadConversation,
  markRead,
  subscribeConversation,
} from './messageStore';

export function useMessageViewport(
  roomId: string,
  onError: (message: string) => void,
  targetId: string | undefined,
  setHighlight: (id: string) => void,
  root?: string,
  onNavigateThread?: (message: import('@/api').Message) => void,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(!targetId);
  const navigating = useRef(Boolean(targetId));
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const jump = async (id: string) => {
    nearBottom.current = false;
    navigating.current = true;
    try {
      const message = await jumpToMessage(roomId, id, root);
      if (message && message.thread_root_id !== root && !(root && message.id === root)) { onNavigateThread?.(message); navigating.current = false; return; }
      setHighlight(id);
      requestAnimationFrame(() => {
        const node = viewport.current;
        const item = node?.querySelector(`[data-message-id="${id}"]`);
        if (node && item) node.scrollTop += item.getBoundingClientRect().top - node.getBoundingClientRect().top - (node.clientHeight - item.getBoundingClientRect().height) / 2;
        navigating.current = false;
      });
    } catch (error) {
      navigating.current = false;
      onError(
        error instanceof Error ? error.message : 'Message is unavailable',
      );
    }
  };
  useMountEffect(() => {
    let stopped = false;
    let frame = 0;
    const read = () => {
      const node = viewport.current;
      if (
        navigating.current ||
        !node ||
        node.scrollHeight - node.scrollTop - node.clientHeight > 40 ||
        !nearBottom.current ||
        document.hidden ||
        !document.hasFocus()
      )
        return;
      const state = conversationSnapshot(roomId, root);
      const latest = state.messages.at(-1);
      if (!state.loading && latest)
        void markRead(roomId, latest, root).catch((error) =>
          onError(
            error instanceof Error
              ? error.message
              : 'Could not mark messages as read',
          ),
        );
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (stopped) return;
        if (nearBottom.current && !navigating.current)
          if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
        read();
      });
    };
    const resize = new ResizeObserver(() => {
      if (nearBottom.current && !navigating.current && viewport.current)
        viewport.current.scrollTop = viewport.current.scrollHeight;
      update();
    });
    if (viewport.current) resize.observe(viewport.current);
    const unsubscribe = subscribeConversation(roomId, update, root);
    const observer = new IntersectionObserver(
      ([entry]) => {
        nearBottom.current = entry.isIntersecting;
        setAwayFromBottom(!entry.isIntersecting);
        if (entry.isIntersecting) read();
      },
      { root: viewport.current },
    );
    if (end.current) observer.observe(end.current);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    void loadConversation(roomId, false, root).then(() => {
      if (!stopped && targetId) void jump(targetId);
    });
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      unsubscribe();
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  });
  const older = async () => {
    const height = viewport.current?.scrollHeight ?? 0;
    const top = viewport.current?.scrollTop ?? 0;
    nearBottom.current = false;
    await loadConversation(roomId, true, root);
    requestAnimationFrame(() => {
      if (viewport.current)
        viewport.current.scrollTop =
          top + viewport.current.scrollHeight - height;
    });
  };
  return { viewport, end, nearBottom, awayFromBottom, jump, older };
}
