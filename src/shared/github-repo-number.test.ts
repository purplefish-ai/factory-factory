import { describe, expect, it } from 'vitest';
import { parseGitHubIssueLink } from './github-issue-preview';
import { parseGitHubPRLink } from './github-pr-preview';

describe.each([
  { kind: 'issues', other: 'pull', parse: parseGitHubIssueLink },
  { kind: 'pull', other: 'issues', parse: parseGitHubPRLink },
])('$kind URL policy', ({ kind, other, parse }) => {
  it.each([
    ['https://github.com', '', ''],
    ['HTTPS://GITHUB.COM', '', ''],
    ['https://github.com:443', '', ''],
    ['https://github.com', '/', ''],
    ['https://github.com', '/files', '?diff=split#diff-123'],
    ['https://github.com', '/arbitrary/subpath', '?page=2#comment'],
    ['https://github.com', '', '?notification=1#comment'],
  ])('accepts public HTTPS links with suffixes: %s %s %s', (host, path, suffix) => {
    expect(parse(`${host}/Owner/Repo/${kind.toUpperCase()}/42${path}${suffix}`)).toEqual({
      repo: 'Owner/Repo',
      number: 42,
    });
  });

  it('accepts safe integer bounds and leading zeros', () => {
    expect(parse(`https://github.com/o/r/${kind}/9007199254740991`)?.number).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(parse(`https://github.com/o/r/${kind}/00042`)?.number).toBe(42);
  });

  it.each([
    'http://github.com/o/r/KIND/42',
    'https://www.github.com/o/r/KIND/42',
    'https://github.com.evil.test/o/r/KIND/42',
    'https://github.com:444/o/r/KIND/42',
    'https://user@github.com/o/r/KIND/42',
    'https://user:secret@github.com/o/r/KIND/42',
    'https://github.com/-owner/r/KIND/42',
    'https://github.com/o/repo%20name/KIND/42',
    'https://github.com/o/r/KIND/0',
    'https://github.com/o/r/KIND/-1',
    'https://github.com/o/r/KIND/1.5',
    'https://github.com/o/r/KIND/42oops',
    'https://github.com/o/r/KIND/42%2Ffiles',
    'https://github.com/o/r/KIND/9007199254740992',
    'https://github.com/o/r/KIND/',
    '/o/r/KIND/42',
    'not a URL',
  ])('rejects unsupported or malformed links: %s', (url) => {
    expect(parse(url.replace('KIND', kind))).toBeNull();
  });

  it('keeps issue and PR paths distinct', () => {
    expect(parse(`https://github.com/o/r/${other}/42`)).toBeNull();
  });
});
