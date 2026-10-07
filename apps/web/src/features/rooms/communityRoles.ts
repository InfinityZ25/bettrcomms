import type { CommunityRole } from '@/api';

export const roleRank: Record<CommunityRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  member: 1,
};

export function canManageRole(
  actor: string | undefined,
  target: string,
): boolean {
  return (
    (actor === 'owner' || actor === 'admin') &&
    roleRank[actor] > (roleRank[target as CommunityRole] ?? 0)
  );
}

export function canModerateRole(
  actor: string | undefined,
  target: string,
): boolean {
  return (
    (roleRank[actor as CommunityRole] ?? 0) >= roleRank.moderator &&
    (roleRank[actor as CommunityRole] ?? 0) >
      (roleRank[target as CommunityRole] ?? roleRank.member)
  );
}
