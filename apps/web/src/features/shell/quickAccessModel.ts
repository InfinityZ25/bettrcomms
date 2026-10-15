import type { PublicUser, Room } from '@/api';
import type { ConversationPreference } from '@/features/rooms/conversationPreferences';
import type { SettingsPage } from '@/features/settings/SettingsScreen';

export type QuickDestination =
  | { kind: 'room'; room: Room }
  | { kind: 'friend'; friend: PublicUser }
  | { kind: 'setting'; page: SettingsPage }
  | { kind: 'navigation'; page: 'home' | 'friends' | 'recordings' | 'search' };
export type QuickItem = {
  id: string;
  label: string;
  subtitle: string;
  keywords: string;
  group:
    'Conversations' | 'Channels' | 'Rooms' | 'Friends' | 'Settings' | 'Go to';
  destination: QuickDestination;
  favorite?: boolean;
  activity?: string;
};
export type QuickGroup = { value: string; items: QuickItem[] };

const settings: ReadonlyArray<{
  page: SettingsPage;
  label: string;
  subtitle: string;
  keywords: string;
}> = [
  {
    page: 'audio',
    label: 'Audio',
    subtitle: 'Call controls and sounds',
    keywords: 'volume sonido audio mute noise suppression balance voices',
  },
  {
    page: 'voice',
    label: 'Voice & devices',
    subtitle: 'Microphone, speakers and camera',
    keywords: 'microfono mic headphones audifonos dispositivos camara camera',
  },
  {
    page: 'appearance',
    label: 'Appearance',
    subtitle: 'Theme and camera layout',
    keywords: 'apariencia tema theme dark light oscuro layout',
  },
  {
    page: 'notifications',
    label: 'Notifications',
    subtitle: 'Quiet hours and message alerts',
    keywords: 'notificaciones silence silencio quiet hours horarios',
  },
  {
    page: 'profile',
    label: 'Profile',
    subtitle: 'Name, picture and availability',
    keywords: 'perfil nombre name username avatar foto status estado',
  },
  {
    page: 'connection',
    label: 'Connection',
    subtitle: 'How calls reach your friends',
    keywords: 'conexion network red relay webrtc',
  },
  {
    page: 'recording',
    label: 'Recording',
    subtitle: 'Saved video quality',
    keywords: 'grabacion recording calidad video clips',
  },
  {
    page: 'stream',
    label: 'Streaming',
    subtitle: 'Quality while sharing',
    keywords: 'transmision screen pantalla compartir share fps bitrate quality',
  },
  {
    page: 'account',
    label: 'Account',
    subtitle: 'Devices, drafts and account controls',
    keywords: 'cuenta privacy privacidad sessions sesiones drafts borradores',
  },
  {
    page: 'desktop',
    label: 'Desktop app',
    subtitle: 'Startup and updates',
    keywords: 'escritorio windows mac startup inicio updates actualizaciones',
  },
];

export function normalizeQuickSearch(text: string) {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

/** Only the authorized /rooms and accepted /friends responses enter this index. */
export function quickAccessItems(
  rooms: readonly Room[],
  friends: readonly PublicUser[],
  preferences: Readonly<Record<string, ConversationPreference>> = {},
  desktop = false,
): QuickItem[] {
  const readable = rooms.filter((room) => room.permissions?.read !== false);
  const items: QuickItem[] = readable.map((room) => ({
    id: `room:${room.id}`,
    label: room.display_name || room.name,
    subtitle:
      room.kind === 'direct'
        ? 'Direct message'
        : room.kind === 'group'
          ? 'Group conversation'
          : `${room.community_name || 'Channel'}${room.channel_type === 'announcement' ? ' · Announcements' : ' · Text and voice'}`,
    keywords: `${room.community_name || ''} ${room.topic || ''} ${room.kind === 'direct' ? 'dm mensaje' : room.kind === 'group' ? 'grupo' : 'channel canal'}`,
    group:
      room.kind === 'direct' || room.kind === 'group'
        ? 'Conversations'
        : 'Channels',
    destination: { kind: 'room', room },
    favorite: preferences[room.id]?.favorite,
    activity: room.activity_at || room.created_at,
  }));
  const communities = new Map<string, Room[]>();
  for (const room of readable) {
    if (!room.community_id) continue;
    communities.set(room.community_id, [
      ...(communities.get(room.community_id) || []),
      room,
    ]);
  }
  for (const [id, channels] of communities) {
    const first = [...channels].sort(
      (a, b) =>
        (a.position || 0) - (b.position || 0) || a.id.localeCompare(b.id),
    )[0];
    items.push({
      id: `community:${id}`,
      label: first.community_name || first.name,
      subtitle: `Room · ${channels.length} accessible channel${channels.length === 1 ? '' : 's'}`,
      keywords: `community comunidad room sala ${channels.map((channel) => channel.name).join(' ')}`,
      group: 'Rooms',
      destination: { kind: 'room', room: first },
    });
  }
  for (const friend of friends)
    items.push({
      id: `friend:${friend.id}`,
      label: friend.name,
      subtitle: friend.username
        ? `Friend · @${friend.username}`
        : 'Friend · Open a direct message',
      keywords: `friend amigo ${friend.username || ''}`,
      group: 'Friends',
      destination: { kind: 'friend', friend },
    });
  for (const setting of settings) {
    if (setting.page === 'desktop' && !desktop) continue;
    items.push({
      id: `setting:${setting.page}`,
      label: setting.label,
      subtitle: `Settings · ${setting.subtitle}`,
      keywords: `settings ajustes ${setting.keywords}`,
      group: 'Settings',
      destination: { kind: 'setting', page: setting.page },
    });
  }
  for (const [page, label, keywords] of [
    ['home', 'Home', 'inicio'],
    ['friends', 'Find friends', 'amigos agregar solicitudes'],
    ['recordings', 'Recordings library', 'grabaciones videos clips'],
    ['search', 'Search messages', 'buscar mensajes archivos enlaces'],
  ] as const)
    items.push({
      id: `navigation:${page}`,
      label,
      subtitle: 'Go to',
      keywords,
      group: 'Go to',
      destination: { kind: 'navigation', page },
    });
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function matchScore(item: QuickItem, tokens: string[], query: string) {
  const label = normalizeQuickSearch(item.label);
  const secondary = normalizeQuickSearch(`${item.subtitle} ${item.keywords}`);
  let score = 0;
  for (const token of tokens) {
    if (label === token) score += 1000;
    else if (label.startsWith(token)) score += 700;
    else if (label.split(/\s+/).some((word) => word.startsWith(token)))
      score += 550;
    else if (label.includes(token)) score += 400;
    else if (secondary.includes(token)) score += 150;
    else return -1;
  }
  return score + (label === query ? 1000 : 0);
}

/** Bounded DOM results; searching still considers every authorized destination. */
export function quickAccessGroups(
  items: readonly QuickItem[],
  text: string,
): QuickGroup[] {
  const query = normalizeQuickSearch(text).replace(/(^|\s)[@#]/g, '$1');
  const tokens = query.split(/\s+/).filter(Boolean);
  const ranked = items
    .map((item, index) => ({
      item,
      index,
      score: tokens.length ? matchScore(item, tokens, query) : 0,
    }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => {
      if (tokens.length) return b.score - a.score || a.index - b.index;
      return (
        Number(Boolean(b.item.favorite)) - Number(Boolean(a.item.favorite)) ||
        (Date.parse(b.item.activity || '') || 0) -
          (Date.parse(a.item.activity || '') || 0) ||
        a.index - b.index
      );
    });
  const groups = new Map<string, QuickGroup>();
  let count = 0;
  for (const { item } of ranked) {
    const group = groups.get(item.group) || { value: item.group, items: [] };
    const limit = tokens.length
      ? 6
      : item.group === 'Settings' || item.group === 'Friends'
        ? 4
        : 5;
    if (group.items.length >= limit || count >= 24) continue;
    group.items.push(item);
    groups.set(item.group, group);
    count++;
  }
  return [...groups.values()];
}

export function isQuickAccessShortcut(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'ctrlKey'
    | 'metaKey'
    | 'shiftKey'
    | 'altKey'
    | 'repeat'
    | 'isComposing'
    | 'defaultPrevented'
  >,
) {
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k'
  );
}
