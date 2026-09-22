import { describe, expect, it } from 'vitest';
import { initials, leadingInitials, trustedAvatar } from './avatar';

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Murray Hopper')).toBe('GB');
    expect(initials('alice')).toBe('A');
  });

  it('takes leading letters where the label may be one word', () => {
    expect(leadingInitials('Friend')).toBe('FR');
    expect(leadingInitials('a')).toBe('A');
  });
});

/**
 * Rendering a remote picture is a request to somewhere else, which tells that
 * host who is looking and when. WorkOS serves its own pictures and proxies the
 * providers' through workoscdn.com — confirmed against the stored value for a
 * real sign-in — so that is the only host worth trusting with it.
 */
describe('which profile pictures are loaded', () => {
  it('loads one WorkOS served', () => {
    expect(trustedAvatar('https://workoscdn.com/images/v1/abc')).toBe(
      'https://workoscdn.com/images/v1/abc',
    );
    expect(trustedAvatar('https://cdn.workoscdn.com/x.png')).toBe(
      'https://cdn.workoscdn.com/x.png',
    );
  });

  it('loads nothing from anywhere else', () => {
    for (const url of [
      'https://lh3.googleusercontent.com/a/portrait',
      'https://evil.example/track.gif',
      // A host that merely ends in the trusted name is a different host.
      'https://workoscdn.com.evil.example/x.png',
      'https://notworkoscdn.com/x.png',
      // Plaintext would leak the request to anything on the path.
      'http://workoscdn.com/images/v1/abc',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(trustedAvatar(url)).toBeUndefined();
    }
  });

  it('treats an absent picture as absent', () => {
    expect(trustedAvatar(null)).toBeUndefined();
    expect(trustedAvatar(undefined)).toBeUndefined();
  });
});
