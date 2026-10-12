import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Room, User } from '@/api';
import type { WatchTogetherState } from './activityApi';
import { YouTubeWatchPlayer } from './YouTubeWatchPlayer';

// Server rendering has no committed event subscription; keep callbacks inert.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffectEvent: <T extends (...args: never[]) => unknown>(callback: T) =>
    callback,
}));

const user: User = { id: 'host', name: 'Host', email: 'host@example.test' };
const room: Room = {
  id: 'room',
  name: 'Room',
  owner_id: user.id,
  created_at: '2026-10-11T00:00:00Z',
  can_post: true,
  can_join_voice: true,
  permissions: {
    read: true,
    post: true,
    join_voice: true,
    manage_channels: false,
    manage_members: false,
    manage_roles: false,
    moderate: false,
    manage_community: false,
    manage_invites: false,
    pin_messages: false,
  },
};
const state: WatchTogetherState = {
  room_id: room.id,
  host_id: user.id,
  source_kind: 'youtube',
  playback_id: 'playback',
  youtube: { id: 'abcdefghijk', title: 'Shared video' },
  attachment: { id: '', filename: '', content_type: '', size_bytes: 0 },
  paused: true,
  position_seconds: 0,
  revision: 1,
  can_claim: false,
  updated_at: '2026-10-11T00:00:00Z',
  server_time: '2026-10-11T00:00:00Z',
};
function player(post: boolean) {
  return renderToStaticMarkup(
    <YouTubeWatchPlayer
      room={{ ...room, permissions: { ...room.permissions!, post } }}
      user={user}
      state={state}
      receivedAt={0}
      joined
      act={async () => true}
      busy={false}
    />,
  );
}

describe('YouTube host permission changes', () => {
  it('withdraws shared controls after post permission loss while retaining local viewing', () => {
    const html = player(false);
    expect(html).not.toContain('Play for everyone');
    expect(html).not.toContain('YouTube shared position');
    expect(html).not.toContain('End session');
    expect(html).toContain('Allow YouTube and start playback');
    expect(html).toContain('YouTube local volume');
    expect(html).toContain('Resume synchronization');
  });
  it('shows shared controls to the current host with post permission', () => {
    const html = player(true);
    expect(html).toContain('Play for everyone');
    expect(html).toContain('YouTube shared position');
    expect(html).toContain('End session');
  });
});
