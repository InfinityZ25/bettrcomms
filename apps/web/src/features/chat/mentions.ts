import type { Message, User } from '@/api';

export function mentionLabel(
  person: Pick<User, 'id' | 'name'>,
  people: Pick<User, 'id' | 'name'>[],
) {
  const duplicates = people.filter(
    (member) => member.name === person.name && member.id !== person.id,
  );
  if (!duplicates.length) return `@${person.name}`;
  const suffix = duplicates.some(
    (member) => member.id.slice(0, 8) === person.id.slice(0, 8),
  )
    ? person.id
    : person.id.slice(0, 8);
  return `@${person.name}#${suffix}`;
}

export function encodeMentions(body: string, mentions: Map<string, string>) {
  if (!mentions.size) return body;
  const labels = [...mentions.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // A selected @Ann must never turn the text @Anna into a different mention.
  const pattern = new RegExp(`(${labels.join('|')})(?![\\p{L}\\p{N}_#])`, 'gu');
  return body.replace(pattern, (label) => `<@${mentions.get(label)}>`);
}

export function editableMessage(message: Message, members: User[]) {
  const mentions = new Map<string, string>();
  const people = [
    ...new Map(
      [...members, ...(message.mentions ?? [])].map((person) => [
        person.id,
        person,
      ]),
    ).values(),
  ];
  const byId = new Map(
    (message.mentions ?? []).map((person) => [person.id.toLowerCase(), person]),
  );
  const body = message.body.replace(
    /<@([0-9a-f-]{36})>/gi,
    (token, id: string) => {
      const person = byId.get(id.toLowerCase());
      if (!person) return token;
      const label = mentionLabel(person, people);
      mentions.set(label, person.id);
      return label;
    },
  );
  return { body, mentions };
}
