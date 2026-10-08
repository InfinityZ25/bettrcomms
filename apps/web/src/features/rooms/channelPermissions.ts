export const channelPermissions = [
  {
    key: 'read',
    label: 'View channel',
    description: 'Read messages, files and events.',
  },
  {
    key: 'post',
    label: 'Send messages',
    description: 'Post messages, files, reactions and polls.',
  },
  {
    key: 'join_voice',
    label: 'Join voice',
    description: 'Join the channel call and shared activities.',
  },
  {
    key: 'pin_messages',
    label: 'Pin messages',
    description: 'Add and remove channel pins.',
  },
] as const;
export type ChannelPermission = (typeof channelPermissions)[number]['key'];
export type PermissionValue = 'allow' | 'deny';
export interface CustomRole {
  id: string;
  community_id: string;
  name: string;
  color: string;
  permissions: Partial<Record<ChannelPermission, boolean>>;
  updated_at: string;
}
export interface ChannelOverride {
  subject_key: string;
  permissions: Partial<Record<ChannelPermission, PermissionValue>>;
}
export interface ChannelAccess {
  is_private: boolean;
  overrides: ChannelOverride[];
  effective_members?: {
    user_id: string;
    name: string;
    role: string;
    read: boolean;
    post: boolean;
    join_voice: boolean;
    pin_messages: boolean;
  }[];
}

export function setChannelOverride(
  overrides: ChannelOverride[],
  subject: string,
  permission: ChannelPermission,
  value: PermissionValue | 'inherit',
): ChannelOverride[] {
  const current = overrides.find(
    (override) => override.subject_key === subject,
  );
  const permissions = { ...current?.permissions };
  if (value === 'inherit') delete permissions[permission];
  else permissions[permission] = value;
  const others = overrides.filter(
    (override) => override.subject_key !== subject,
  );
  return Object.keys(permissions).length
    ? [...others, { subject_key: subject, permissions }]
    : others;
}
