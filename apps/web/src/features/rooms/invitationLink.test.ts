import { afterEach, describe, expect, it, vi } from 'vitest';
import { invitationToken, pendingInvitation, rememberInvitation } from './invitationLink';
import { isConversationRoom, sectionForRoom } from '@/features/shell/sections';

const token = 'a'.repeat(43);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('invitation links', () => {
  it('accepts fragment links and rejects script, query and malformed tokens', () => {
    expect(invitationToken(`https://comms.example/#/?invite=${token}`)).toBe(token);
    expect(invitationToken(` ${token} `)).toBe(token);
    for (const link of [`javascript:alert(1)#/?invite=${token}`, `https://comms.example/?invite=${token}`, 'short', `https://comms.example/#/?invite=${'x'.repeat(129)}`]) expect(invitationToken(link)).toBeNull();
  });
  it('retains an invitation through sign-in, removes its URL token and expires pending intent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const items = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) });
    vi.stubGlobal('window', { location: { href: `https://comms.example/#/?invite=${token}&extra=yes` }, history: { state: {}, replaceState } });
    expect(pendingInvitation()).toBe(token);
    rememberInvitation(token);
    expect(String(replaceState.mock.calls[0][2])).toBe('https://comms.example/#/?extra=yes');
    vi.stubGlobal('window', { location: { href: 'https://comms.example/#/' }, history: { state: {}, replaceState } });
    expect(pendingInvitation()).toBe(token);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    expect(pendingInvitation()).toBeNull();
    rememberInvitation(null);
    expect(items.size).toBe(0);
  });
  it('tolerates disabled browser storage', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('disabled'); }, setItem: () => { throw new Error('disabled'); } });
    vi.stubGlobal('window', { location: { href: 'https://comms.example/#/' } });
    expect(pendingInvitation()).toBeNull();
    expect(() => rememberInvitation(token)).not.toThrow();
  });
});
it('routes group conversations to messages and leaves channels in calls', () => {
  expect(sectionForRoom('group')).toBe('messages');
  expect(sectionForRoom('direct')).toBe('messages');
  expect(sectionForRoom(undefined)).toBe('calls');
  expect(isConversationRoom('channel')).toBe(false);
});
