import { describe, expect, it } from 'vitest';
import { buildIssueStartPrompt } from './issue-start-prompt';

describe('buildIssueStartPrompt', () => {
  it.each([
    'https://github.com/acme/repo/issues/42',
    'https://linear.app/acme/issue/ENG-42/fix-login',
  ])('hands off %s by reference without embedding issue context', (url) => {
    expect(buildIssueStartPrompt({ url })).toBe(
      `Fetch and address this issue: ${url}\n\nCreate a PR when done.`
    );
  });
});
