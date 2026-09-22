import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every form has to carry a real submit button.
 *
 * The shared Button renders Base UI's button primitive, and that primitive
 * defaults every button it draws to `type="button"`. Inside a `<form onSubmit>`
 * such a button is inert: the click fires nothing, and the failure is
 * completely silent — no request, no error, no closed dialog. "Create room"
 * shipped that way and looked like an intermittent bug, because the only route
 * left was the browser's implicit submission on Enter, which needs focus in the
 * field and does not always apply.
 *
 * A DOM test would be the direct way to check this, and this codebase has no
 * DOM test setup. Counting is the cheap version of the same rule, and it fails
 * for the case that actually happens: someone writes a form and lets the
 * button's default type stand.
 */
const SOURCE = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('forms', () => {
  it('give every form a button that submits it', () => {
    const offenders = sources(SOURCE)
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => text.includes('<form'))
      .map(({ path, text }) => ({
        file: path.slice(SOURCE.length).replace(/\\/g, '/'),
        forms: text.split('<form').length - 1,
        submits: text.split('type="submit"').length - 1,
      }))
      .filter((file) => file.submits < file.forms);

    expect(offenders).toEqual([]);
  });
});
