import { describe, expect, it } from 'vitest';
import { parseGitHubPRLink } from './github-pr-preview';

describe('parseGitHubPRLink', () => {
  it.each([
    'https://github.com/Owner/Repo/pull/42',
    'https://github.com/Owner/Repo/PULL/42',
    'https://github.com/Owner/Repo/PuLl/42',
    'https://github.com/Owner/Repo/pull/42/files?diff=split#diff-123',
  ])('recognizes PR links and preserves repository display casing: %s', (url) => {
    expect(parseGitHubPRLink(url)).toEqual({ repo: 'Owner/Repo', number: 42 });
  });

  it.each([
    'https://github.com.evil.test/o/r/pull/42',
    'https://evil.test/github.com/o/r/pull/42',
    'https://github.com/o/r/issues/42',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/9007199254740992',
    'https://github.com/o/r/pull/42oops',
    'https://user:secret@github.com/o/r/pull/42',
    'http://github.com/o/r/PULL/42',
    'https://github.com.evil.test/o/r/PULL/42',
    'https://user:secret@github.com/o/r/PULL/42',
    'https://github.com/o/r/PULL/0',
    '/o/r/pull/42',
  ])('leaves other or invalid links alone: %s', (url) => {
    expect(parseGitHubPRLink(url)).toBeNull();
  });
});
