import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/api';
import { editableMessage, encodeMentions } from './mentions';

describe('mention identities', () => {
  it('keeps prefixes and punctuation distinct', () => {
    expect(
      encodeMentions(
        '@Anna @Ann, @Annette @Ann#other @A+B!',
        new Map([
          ['@Ann', 'one'],
          ['@Anna', 'two'],
          ['@A+B', 'three'],
        ]),
      ),
    ).toBe('<@two> <@one>, @Annette @Ann#other <@three>!');
  });
  it('preserves both people with the same name when editing', () => {
    const people = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Alex' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Alex' },
    ];
    const message = {
      body: `<@${people[0].id}> and <@${people[1].id.toUpperCase()}>`,
      mentions: people,
    } as Message;
    const editable = editableMessage(message, people as User[]);
    expect(editable.mentions.size).toBe(2);
    expect(encodeMentions(editable.body, editable.mentions)).toBe(
      `<@${people[0].id}> and <@${people[1].id}>`,
    );
  });
});
