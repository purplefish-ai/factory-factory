import { randomInt } from 'node:crypto';

/** Letters and digits without look-alikes (no i, l, o, 0 or 1). */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PREFIX = 'Factory Factory check';
const CODE = '[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}';
const VERIFICATION_TEXT = new RegExp(`^${PREFIX.toLowerCase()} ${CODE}$`);

/**
 * A fresh verification code: twelve characters from a 31-letter alphabet
 * (about 59 bits), grouped for reading. It proves delivery, not identity, and
 * is safe to post in a channel.
 */
export function createSlackVerificationCode() {
  const characters = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 4, 8].map((start) => characters.slice(start, start + 4).join('')).join('-');
}

/** The exact message the user posts in each selected channel. */
export function slackVerificationMessage(code: string) {
  return `${PREFIX} ${code}`;
}

/**
 * Slack may keep leading or trailing spaces and a retyped message may differ in
 * case. Only ASCII letters fold: Unicode case folding would accept look-alikes
 * such as the Kelvin sign for `k`.
 */
function normalize(text: string) {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The whole message must be the verification message for this code; nothing else matches. */
export function isSlackVerificationFor(text: string, code: string) {
  return normalize(text) === normalize(slackVerificationMessage(code));
}

/** Any verification message, for any code. These never start a run for any trigger. */
export function isSlackVerificationText(text: string) {
  return VERIFICATION_TEXT.test(normalize(text));
}
