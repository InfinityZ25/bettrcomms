import { useRef, useState } from 'react';
import { api } from '@/api';
import { useMountEffect } from '@/hooks/useMountEffect';

export type PostingState = { slow_mode_seconds: number; restricted_until?: string; next_post_at?: string };
const listeners = new Map<string, Set<() => void>>();
export function invalidatePostingState(room: string) { for (const listener of listeners.get(room) ?? []) listener(); }

/** Use in a conversation keyed by account/room. Network reads occur on mount,
 * an actual moderation event or own send; one timer only redraws at expiry. */
export function usePostingState(roomId: string) {
  const [state, setState] = useState<PostingState>();
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await api<{ state: PostingState }>(`/rooms/${roomId}/moderation`, undefined, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setState(result.state); setNow(Date.now());
      if (timer.current) clearTimeout(timer.current);
      const schedule = () => {
        const future = [result.state.restricted_until, result.state.next_post_at].map((value) => Date.parse(value ?? '') || 0).filter((value) => value > Date.now());
        if (future.length) timer.current = setTimeout(() => { setNow(Date.now()); schedule(); }, Math.min(2_147_000_000, Math.min(...future) - Date.now() + 50));
      };
      schedule();
    } catch { /* A forbidden or expired account is handled by the conversation/session. */ }
  };
  useMountEffect(() => {
    let active = true;
    const listener = () => { if (active) void refresh(); };
    const group = listeners.get(roomId) ?? new Set<() => void>(); group.add(listener); listeners.set(roomId, group);
    void refresh();
    return () => { active = false; group.delete(listener); if (!group.size) listeners.delete(roomId); request.current?.abort(); if (timer.current) clearTimeout(timer.current); };
  });
  const restricted = (Date.parse(state?.restricted_until ?? '') || 0) > now;
  const cooldown = (Date.parse(state?.next_post_at ?? '') || 0) > now;
  const until = restricted ? state?.restricted_until : cooldown ? state?.next_post_at : undefined;
  return { state, restricted, cooldown, blocked: restricted || cooldown, until, reason: restricted ? 'Posting is temporarily restricted in this channel.' : cooldown ? 'Slow mode: wait before sending another message.' : '', refresh };
}
