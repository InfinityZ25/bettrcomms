/**
 * The two things the sidebar can be showing.
 *
 * A section is not a screen: the call stays on screen while you move between
 * them, and the hash route is untouched. It only decides what the sidebar lists
 * — conversations with people, or rooms you call in.
 */
export type Section = 'messages' | 'calls';

/** Where a room belongs. Rooms without a kind are channels. */
export const sectionForRoom = (kind?: string): Section =>
  kind === 'direct' ? 'messages' : 'calls';
