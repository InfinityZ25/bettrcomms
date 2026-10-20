import type { Emote } from './brain';

/**
 * The little marks that pop over a creature's head, comic-strip style.
 *
 * Drawn as paths rather than emoji so they look the same on every platform
 * and theme, and so each costs a few hundred bytes of static markup. They are
 * decoration: whatever caused one is already announced somewhere real.
 */
const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const EMOTE_MARKUP: Record<Exclude<Emote, 'confetti' | 'zzz'>, string> = {
  heart: svg('<path d="M12 20.5s-7.6-4.5-9.3-9.3C1.5 7.8 3.6 4.6 7 4.6c2 0 3.6 1.1 5 2.9 1.4-1.8 3-2.9 5-2.9 3.4 0 5.5 3.2 4.3 6.6-1.7 4.8-9.3 9.3-9.3 9.3z"/>'),
  exclaim: svg('<path d="M9.6 3.2h4.8l-1 11.2h-2.8z"/><circle cx="12" cy="18.6" r="2.3"/>'),
  question: svg('<path d="M8 8.4a4 4 0 1 1 6.3 3.3c-1.3.9-2 1.6-2 3.1" fill="none" stroke-width="3" stroke-linecap="round"/><circle cx="12.3" cy="19.4" r="2"/>'),
  note: svg('<path d="M9 17.5V5.2l10-2.2v11.8" fill="none" stroke-width="2.6" stroke-linejoin="round"/><ellipse cx="6.6" cy="17.6" rx="3.3" ry="2.6"/><ellipse cx="16.6" cy="15.4" rx="3.3" ry="2.6"/>'),
  sparkle: svg('<path d="M12 1.8c.9 5.4 4.7 9.3 10.2 10.2-5.5.9-9.3 4.8-10.2 10.2-.9-5.4-4.7-9.3-10.2-10.2C7.3 11.1 11.1 7.2 12 1.8z"/>'),
  anger: svg('<path d="M9 2.8v4.1a2.2 2.2 0 0 1-2.2 2.2H2.8M15 2.8v4.1a2.2 2.2 0 0 0 2.2 2.2h4M9 21.2v-4.1a2.2 2.2 0 0 0-2.2-2.2H2.8M15 21.2v-4.1a2.2 2.2 0 0 1 2.2-2.2h4" fill="none" stroke-width="2.8" stroke-linecap="round"/>'),
  sweat: svg('<path d="M12 2.5c3.4 4.9 5.6 8.2 5.6 11a5.6 5.6 0 0 1-11.2 0c0-2.8 2.2-6.1 5.6-11z"/><path d="M9.7 13.6a2.4 2.4 0 0 0 1.7 2.6" fill="none" stroke-width="1.5" stroke-linecap="round" class="pet-emote-shine"/>'),
  dots: svg('<path d="M4.5 4h15A2.5 2.5 0 0 1 22 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.6 3.6V17H4.5A2.5 2.5 0 0 1 2 14.5v-8A2.5 2.5 0 0 1 4.5 4z" class="pet-emote-bubble"/><circle cx="7.4" cy="10.5" r="1.6"/><circle cx="12" cy="10.5" r="1.6"/><circle cx="16.6" cy="10.5" r="1.6"/>'),
  swirl: svg('<path d="M12 12.4c.6-.9-.3-2-1.3-1.6-1.4.5-1.2 2.5.1 3 2 .8 3.9-1 3.4-3.1-.6-2.6-3.8-3.5-5.9-1.9-2.6 2-2 6.1 1 7.4 3.6 1.5 7.4-1.2 7.3-5.1C16.5 6.8 12 4 7.8 5.7" fill="none" stroke-width="2.2" stroke-linecap="round"/>'),
};

export const ZZZ_MARKUP = svg('<path d="M4 9h6l-6 7h6" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>');

/** Confetti flies outwards from the head: a direction, a spin and a colour per piece. */
export const CONFETTI = [
  { dx: -34, dy: -46, r: -160, hue: 'var(--pet-confetti-1)' },
  { dx: -18, dy: -62, r: 220, hue: 'var(--pet-confetti-2)' },
  { dx: 2, dy: -70, r: -250, hue: 'var(--pet-confetti-3)' },
  { dx: 20, dy: -60, r: 180, hue: 'var(--pet-confetti-4)' },
  { dx: 36, dy: -44, r: -200, hue: 'var(--pet-confetti-1)' },
  { dx: -44, dy: -22, r: 140, hue: 'var(--pet-confetti-3)' },
  { dx: 44, dy: -24, r: -120, hue: 'var(--pet-confetti-2)' },
  { dx: 8, dy: -38, r: 300, hue: 'var(--pet-confetti-4)' },
] as const;
