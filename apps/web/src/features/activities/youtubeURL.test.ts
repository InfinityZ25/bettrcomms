import { describe, expect, it } from 'vitest';
import { youtubeWatchURL } from './youtubeURL';

describe('YouTube watch link recognition', () => {
  it.each([
    'https://youtu.be/M7lc1UVf-VE?si=share',
    'https://www.youtube.com/watch?v=M7lc1UVf-VE&list=PL123',
    'https://youtube.com/shorts/M7lc1UVf-VE',
    ' https://m.youtube.com/watch?v=M7lc1UVf-VE ',
  ])('recognizes a supported shared video: %s', (value) => {
    expect(youtubeWatchURL(value)).toBe(
      'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    );
  });
  it.each([
    'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE',
    'https://user:password@youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com:443/watch?v=M7lc1UVf-VE',
    'http://youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtu.be/M7lc1UVf-VE/extra',
    'https://youtube.com/playlist?list=PL123',
    'https://youtube.com/watch?v=short',
    '||https://youtu.be/M7lc1UVf-VE||',
    '`https://youtu.be/M7lc1UVf-VE`',
    'Here is https://youtu.be/M7lc1UVf-VE',
  ])(
    'leaves unsupported, hidden or ordinary message text alone: %s',
    (value) => {
      expect(youtubeWatchURL(value)).toBeUndefined();
    },
  );
});
