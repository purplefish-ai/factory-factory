import { describe, expect, it } from 'vitest';
import { parseAdversarialReviewFindings } from './adversarial-review-findings.schema';

describe('parseAdversarialReviewFindings', () => {
  it('parses a valid findings block with comments', () => {
    const message = [
      'Here is my review.',
      '',
      '```json',
      JSON.stringify({
        summary: 'Found one bug.',
        comments: [
          {
            path: 'src/foo.ts',
            line: 12,
            side: 'RIGHT',
            severity: 'blocking',
            body: 'Off by one.',
          },
        ],
      }),
      '```',
    ].join('\n');

    expect(parseAdversarialReviewFindings(message)).toEqual({
      summary: 'Found one bug.',
      comments: [
        { path: 'src/foo.ts', line: 12, side: 'RIGHT', severity: 'blocking', body: 'Off by one.' },
      ],
    });
  });

  it('accepts an empty comments array for a clean review', () => {
    const message = [
      '```json',
      JSON.stringify({ summary: 'Looks good.', comments: [] }),
      '```',
    ].join('\n');

    expect(parseAdversarialReviewFindings(message)).toEqual({
      summary: 'Looks good.',
      comments: [],
    });
  });

  it('uses the last fenced JSON block when the model emits more than one', () => {
    const message = [
      '```json',
      JSON.stringify({ summary: 'Draft, ignore', comments: [] }),
      '```',
      'Actually, here is the real one:',
      '```json',
      JSON.stringify({ summary: 'Final review.', comments: [] }),
      '```',
    ].join('\n');

    expect(parseAdversarialReviewFindings(message).summary).toBe('Final review.');
  });

  it('throws when no fenced JSON block is present', () => {
    expect(() => parseAdversarialReviewFindings('Just some prose, no findings block.')).toThrow(
      /no fenced json/i
    );
  });

  it('throws when the fenced block is not valid JSON', () => {
    const message = ['```json', 'not valid json', '```'].join('\n');
    expect(() => parseAdversarialReviewFindings(message)).toThrow(/not valid json/i);
  });

  it('throws when a comment references an invalid side or severity', () => {
    const message = [
      '```json',
      JSON.stringify({
        summary: 'Bad comment.',
        comments: [{ path: 'a.ts', line: 1, side: 'MIDDLE', severity: 'blocking', body: 'x' }],
      }),
      '```',
    ].join('\n');

    expect(() => parseAdversarialReviewFindings(message)).toThrow(/failed validation/i);
  });
});
