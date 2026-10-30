import { describe, expect, it } from 'vitest';
import { parseGitHubIssueLink } from './github-issue-preview';

describe('parseGitHubIssueLink', () => {
  it.each([
    'https://github.com/Owner/Repo/issues/42',
    'https://github.com/Owner/Repo/issues/42?notification_referrer_id=123#issuecomment-123',
  ])('recognizes issue links and preserves repository display casing: %s', (url) => {
    expect(parseGitHubIssueLink(url)).toEqual({ repo: 'Owner/Repo', number: 42 });
  });

  it.each([
    'https://github.com.evil.test/o/r/issues/42',
    'https://evil.test/github.com/o/r/issues/42',
    'https://github.com/o/r/pull/42',
    'https://github.com/o/r/issues/0',
    'https://github.com/o/r/issues/9007199254740992',
    'https://github.com/o/r/issues/42oops',
    'https://user:secret@github.com/o/r/issues/42',
    '/o/r/issues/42',
    'http://github.com/o/r/issues/42',
    'https://github.com/-o/r/issues/42',
  ])('leaves other or invalid links alone: %s', (url) => {
    expect(parseGitHubIssueLink(url)).toBeNull();
  });
});
