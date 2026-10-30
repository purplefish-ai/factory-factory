import { describe, expect, it } from 'vitest';
import { compileQuestionPattern, getStringAnswerError } from './question-validation';

describe('string question validation', () => {
  it('matches provider patterns without catastrophic backtracking', () => {
    expect(
      getStringAnswerError({ type: 'string', pattern: '^(a+)+$' }, `${'a'.repeat(30_000)}!`)
    ).toBe('Use the requested format.');
  });

  it('keeps substring matching and accepts matching answers', () => {
    expect(getStringAnswerError({ type: 'string', pattern: 'ab+c' }, 'xxabbbcxx')).toBeNull();
  });

  it('rejects unsupported, invalid, and oversized patterns safely', () => {
    for (const pattern of [
      '(?=a)a',
      '(a)\\1',
      '[',
      'a'.repeat(1025),
      `(${'a'.repeat(500)}){1000}`,
      '(a{1000}){1000}',
      '(abcdef){1000}',
    ]) {
      expect(() => compileQuestionPattern(pattern)).toThrow();
      expect(getStringAnswerError({ type: 'string', pattern }, 'answer')).toBe(
        'The requested response format is unsupported.'
      );
    }
  });

  it('evicts compiled patterns when their total program size exceeds the cache budget', () => {
    const original = compileQuestionPattern('x'.repeat(400));
    for (let index = 0; index < 50; index++) {
      compileQuestionPattern(`${'x'.repeat(400)}${index}`);
    }
    expect(compileQuestionPattern('x'.repeat(400))).not.toBe(original);
  });

  it.each([
    [{ minLength: 4 }, 'a', 'Enter at least 4 characters.'],
    [{ maxLength: 4 }, 'abcde', 'Enter no more than 4 characters.'],
    [{ pattern: '^SECRET-[0-9]+$' }, 'invalid', 'Use the requested format.'],
    [{ format: 'email' }, 'invalid', 'Enter a valid email address.'],
    [{ format: 'uri' }, 'invalid', 'Enter a valid URL.'],
    [{ format: 'date' }, 'invalid', 'Enter a date in YYYY-MM-DD format.'],
    [{ format: 'date-time' }, 'invalid', 'Enter a date and time with a timezone.'],
  ] as const)('uses friendly copy for %o', (rules, answer, error) => {
    expect(getStringAnswerError({ type: 'string', ...rules }, answer)).toBe(error);
  });

  it('counts string length in Unicode code points', () => {
    expect(getStringAnswerError({ type: 'string', maxLength: 1 }, '👍')).toBeNull();
    expect(getStringAnswerError({ type: 'string', minLength: 2 }, '𝔸')).toBe(
      'Enter at least 2 characters.'
    );
  });
});
