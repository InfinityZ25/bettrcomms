import { describe, expect, it } from 'vitest';
import { setChannelOverride } from './channelPermissions';

describe('channel override editing', () => {
  it('preserves other subjects and permissions while removing inherited entries', () => {
    const original = [
      {
        subject_key: 'member',
        permissions: { read: 'allow' as const, post: 'deny' as const },
      },
      { subject_key: 'everyone', permissions: { join_voice: 'deny' as const } },
    ];
    const edited = setChannelOverride(original, 'member', 'read', 'inherit');
    expect(edited).toEqual([
      { subject_key: 'everyone', permissions: { join_voice: 'deny' } },
      { subject_key: 'member', permissions: { post: 'deny' } },
    ]);
    expect(original[0].permissions.read).toBe('allow');
    expect(setChannelOverride(edited, 'member', 'post', 'inherit')).toEqual([
      { subject_key: 'everyone', permissions: { join_voice: 'deny' } },
    ]);
  });
});
