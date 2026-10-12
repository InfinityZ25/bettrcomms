import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room, User } from '@/api';
import type { WatchTogetherState } from './activityApi';
import { youtubeRequiresBrowser } from './youtubePlatform';
import { YouTubeWatchPlayer } from './YouTubeWatchPlayer';
import { WatchTogetherPanel } from './WatchTogetherPanel';

const host = vi.hoisted(() => ({
  runtime: 'wails',
  platform: 'darwin',
  mount: vi.fn(),
}));
vi.mock('@/desktop/runtime', async (original) => ({
  ...(await original<typeof import('@/desktop/runtime')>()),
  getDesktopRuntime: () => host.runtime,
  readDesktopBootReport: () => ({
    runtime: host.runtime,
    platform: host.platform,
  }),
}));
vi.mock('@/hooks/useMountEffect', () => ({ useMountEffect: host.mount }));
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
};
const state: WatchTogetherState = {
  room_id: room.id,
  host_id: user.id,
  source_kind: 'youtube',
  playback_id: 'playback',
  youtube: { id: 'abcdefghijk', title: 'Shared video' },
  attachment: {
    id: 'file',
    filename: 'movie.mp4',
    content_type: 'video/mp4',
    size_bytes: 100,
  },
  paused: true,
  position_seconds: 0,
  revision: 1,
  can_claim: false,
  updated_at: '2026-10-11T00:00:00Z',
  server_time: '2026-10-11T00:00:00Z',
};

describe('Windows-only native YouTube gate', () => {
  beforeEach(() => {
    host.runtime = 'wails';
    host.platform = 'darwin';
    host.mount.mockClear();
  });

  it.each([
    ['wails', 'darwin', true],
    ['wails', 'windows', false],
    ['wails', 'linux', true],
    ['wails', 'ios', true],
    ['wails', 'android', true],
    ['wails', 'unknown', true],
    ['wails', '', true],
    ['browser', 'darwin', false],
    ['browser', 'macos', false],
    ['browser', 'linux', false],
  ])('applies only to %s on %s', (runtime, platform, expected) => {
    host.runtime = runtime;
    host.platform = platform;
    expect(youtubeRequiresBrowser()).toBe(expected);
  });

  it.each(['darwin', 'linux', 'unknown', ''])(
    'creates no player scope, iframe, or consent control on %s desktop',
    (platform) => {
      host.platform = platform;
      const html = renderToStaticMarkup(
        <YouTubeWatchPlayer
          room={room}
          user={user}
          state={state}
          receivedAt={0}
          joined
          act={async () => true}
          busy={false}
        />,
      );
      expect(host.mount).not.toHaveBeenCalled();
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('Allow YouTube');
      expect(html).toContain('Open BetterComms in your browser');
      expect(html).toContain('desktop app on this platform');
    },
  );

  it.each(['darwin', 'linux'])(
    'retains file watching and private lists on %s while YouTube participation is disabled',
    (platform) => {
      host.platform = platform;
      const html = renderToStaticMarkup(
        <WatchTogetherPanel
          room={room}
          user={user}
          state={{ ...state, source_kind: 'attachment' }}
          receivedAt={0}
          act={async () => true}
          busy={false}
        />,
      );
      expect(html).toContain('<video');
      expect(html).toContain('Start playback');
      expect(html).toContain('Your private YouTube lists');
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('Allow YouTube');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Join Watch<\/button>/);
    },
  );

  it.each([
    ['wails', 'windows'],
    ['browser', 'darwin'],
    ['browser', 'linux'],
  ])('retains the consent flow on %s/%s', (runtime, platform) => {
    host.runtime = runtime;
    host.platform = platform;
    const html = renderToStaticMarkup(
      <YouTubeWatchPlayer
        room={room}
        user={user}
        state={state}
        receivedAt={0}
        joined
        act={async () => true}
        busy={false}
      />,
    );
    expect(html).toContain('Allow YouTube and start playback');
    expect(html).not.toContain('desktop app on this platform');
  });
});
