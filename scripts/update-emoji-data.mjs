import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Pinned Unicode release; regeneration is an explicit maintenance operation.
const source = 'https://unicode.org/Public/17.0.0/emoji/emoji-test.txt';
const response = await fetch(source);
if (!response.ok) throw new Error(`Unicode data HTTP ${response.status}`);
const text = await response.text();
if (!text.includes('# Version: 17.0')) throw new Error('Unexpected Unicode release');
const groups = [];
const entries = [];
let category = -1;
for (const line of text.split('\n')) {
  if (line.startsWith('# group: ')) { groups.push(line.slice(9).trim()); category++; }
  const match = line.match(/^([A-F0-9 ]+)\s*; fully-qualified\s*# \S+ E[\d.]+ (.+)$/);
  if (!match) continue;
  entries.push([String.fromCodePoint(...match[1].trim().split(/\s+/).map((point) => parseInt(point, 16))), match[2].trim(), category]);
}
if (entries.length < 3900) throw new Error('Incomplete Unicode catalog');
await mkdir('apps/web/src/features/chat/emoji', { recursive: true });
await writeFile('apps/web/src/features/chat/emoji/catalog.json', JSON.stringify({ version: '17.0', source, sha256: createHash('sha256').update(text).digest('hex'), groups, entries }) + '\n');
await writeFile('server/internal/api/emoji_sequences.txt', entries.map(([emoji]) => emoji).join('\n') + '\n');
const license = await fetch('https://www.unicode.org/license.txt');
if (!license.ok) throw new Error(`Unicode license HTTP ${license.status}`);
await writeFile('apps/web/src/features/chat/emoji/LICENSE.txt', await license.text());
console.log(`Generated ${entries.length} qualified Unicode emoji for client and server.`);
