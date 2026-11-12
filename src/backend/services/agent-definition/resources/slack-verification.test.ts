import { describe, expect, it } from 'vitest';
import { agentSlackVerificationCodeSchema } from '@/shared/agent-runtime';
import { compareSlackTimestamps } from './agent-runtime-guards';
import {
  createSlackVerificationCode,
  isSlackVerificationFor,
  isSlackVerificationText,
  slackVerificationMessage,
} from './slack-verification';

describe('Slack verification messages', () => {
  it('creates distinct codes from an alphabet without look-alikes', () => {
    const codes = new Set(Array.from({ length: 200 }, createSlackVerificationCode));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(agentSlackVerificationCodeSchema.parse(code)).toBe(code);
      expect(code).not.toMatch(/[ilo01]/);
    }
  });

  it('matches only the whole message for this code, ignoring case and surrounding spaces', () => {
    const message = slackVerificationMessage('abcd-efgh-jkmn');
    expect(message).toBe('Factory Factory check abcd-efgh-jkmn');
    expect(isSlackVerificationFor(message, 'abcd-efgh-jkmn')).toBe(true);
    expect(
      isSlackVerificationFor('  factory  FACTORY check ABCD-EFGH-JKMN\n', 'abcd-efgh-jkmn')
    ).toBe(true);
    for (const text of [
      `${message} please`,
      `Re: ${message}`,
      'Factory Factory check abcd-efgh-jkmp',
      'abcd-efgh-jkmn',
      '',
      // Unicode case folding would turn the Kelvin sign into k.
      'Factory Factory check abcd-efgh-j\u212Amn',
    ]) {
      expect(isSlackVerificationFor(text, 'abcd-efgh-jkmn')).toBe(false);
    }
  });

  it('recognizes any verification message so none can start a run', () => {
    expect(isSlackVerificationText('Factory Factory check zz22-p9q8-r7s6')).toBe(true);
    expect(isSlackVerificationText('Factory Factory check is broken again')).toBe(false);
    expect(isSlackVerificationText('Please run the Factory Factory check abcd-efgh-jkmn')).toBe(
      false
    );
  });
});

describe('compareSlackTimestamps', () => {
  it.each([
    ['1731430000.000100', '1731430000.000100', 0],
    ['1731430000.000101', '1731430000.000100', 1],
    ['1731430000.000099', '1731430000.000100', -1],
    // A float would round these together.
    ['1731430000.0000000000000001', '1731430000.0000000000000002', -1],
    // Lexicographic order would put 999 after 1000.
    ['999.000000', '1000.000000', -1],
    // Different fraction lengths compare as decimals.
    ['1731430000.1', '1731430000.099999', 1],
    ['1731430000.10', '1731430000.1', 0],
  ] as const)('compares %s with %s exactly', (left, right, expected) => {
    expect(compareSlackTimestamps(left, right)).toBe(expected);
  });
});
