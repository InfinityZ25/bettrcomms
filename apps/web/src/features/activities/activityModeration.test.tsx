import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Room, User } from '@/api';
import { EventsPanel } from './EventsPanel';
import { MediaAssetsPanel } from './MediaAssetsPanel';
import { PollsPanel } from './PollsPanel';
import type {
  ChannelMediaAsset,
  ChannelPoll,
  ScheduledChannelEvent,
} from './activityApi';

const user: User = {
  id: 'viewer',
  name: 'Viewer',
  email: 'viewer@example.test',
};
const room: Room = {
  id: 'channel',
  name: 'Announcements',
  owner_id: 'owner',
  created_at: '2026-10-01T00:00:00Z',
  channel_type: 'announcement',
  permissions: {
    read: true,
    post: false,
    moderate: false,
    join_voice: false,
    manage_channels: false,
    manage_members: false,
    manage_roles: false,
    manage_community: false,
    manage_invites: false,
    pin_messages: false,
  },
};
const poll: ChannelPoll = {
  id: 'poll',
  author_id: 'owner',
  question: 'What should we play?',
  options: ['First game', 'Second game'],
  counts: [1, 0],
  vote: null,
  created_at: '2026-10-01T00:00:00Z',
  closes_at: null,
  closed_at: null,
};
const event: ScheduledChannelEvent = {
  id: 'event',
  room_id: room.id,
  author_id: 'owner',
  title: 'Game night',
  description: '',
  starts_at: '2099-10-01T00:00:00Z',
  cancelled_at: null,
  going: 1,
  maybe: 0,
  response: '',
};
const asset: ChannelMediaAsset = {
  id: 'sticker',
  name: 'Victory',
  kind: 'sticker',
  creator_id: 'owner',
  duration_ms: null,
  attachment: {
    id: 'image',
    filename: 'victory.png',
    content_type: 'image/png',
    size_bytes: 100,
  },
};
const act = async () => true;
const refresh = async () => {};

function panels(currentRoom: Room, author = 'owner') {
  return [
    renderToStaticMarkup(
      <PollsPanel
        room={currentRoom}
        user={user}
        polls={[{ ...poll, author_id: author }]}
        busy={false}
        act={act}
      />,
    ),
    renderToStaticMarkup(
      <EventsPanel
        room={currentRoom}
        user={user}
        events={[{ ...event, author_id: author }]}
        busy={false}
        act={act}
      />,
    ),
    renderToStaticMarkup(
      <MediaAssetsPanel
        kind="sticker"
        room={currentRoom}
        user={user}
        assets={[{ ...asset, creator_id: author }]}
        busy={false}
        act={act}
        refresh={refresh}
      />,
    ),
  ];
}

function expectModerationControls(html: string[]) {
  expect(html[0]).toContain('End poll');
  expect(html[1]).toContain('Cancel event');
  expect(html[2]).toContain('aria-label="Remove Victory"');
}

function expectCreationBlocked(html: string[]) {
  expect(html[0]).not.toContain('New poll');
  expect(html[1]).not.toContain('Schedule event');
  expect(html[2]).not.toContain('Add sticker');
  expect(html[2]).toMatch(/<button[^>]*disabled=""[^>]*>.*?Send<\/button>/);
}

describe('activity controls in a readable channel without posting permission', () => {
  it('allows a moderator to end, cancel, and remove other authors’ activities while creation stays blocked', () => {
    const html = panels({
      ...room,
      permissions: { ...room.permissions!, moderate: true },
    });
    expectModerationControls(html);
    expectCreationBlocked(html);
  });

  it('lets an author withdraw their own activities after losing posting permission', () => {
    const html = panels(room, user.id);
    expectModerationControls(html);
    expectCreationBlocked(html);
  });

  it('keeps another reader’s moderation and creation controls unavailable', () => {
    const html = panels(room);
    expect(html[0]).not.toContain('End poll');
    expect(html[1]).not.toContain('Cancel event');
    expect(html[2]).not.toContain('aria-label="Remove Victory"');
    expectCreationBlocked(html);
  });
});
