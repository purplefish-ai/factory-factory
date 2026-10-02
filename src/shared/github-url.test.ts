import { describe, expect, it } from 'vitest';
import { parseGithubUrl } from './github-url';

const prefixes = ['http://github.com/', 'https://github.com/', 'git@github.com:'];
const validUrls = prefixes.flatMap((prefix) =>
  ['', '.git', '/', '.git/'].map((suffix) => `${prefix}OwNeR-1/RePo_2.name${suffix}`)
);
const invalidSegments = [
  '..',
  '.',
  '.name',
  'name.',
  '-name',
  'name-',
  'name space',
  'name%2Fother',
];
const invalidUrls = prefixes.flatMap((prefix) =>
  invalidSegments.flatMap((segment) => [`${prefix}${segment}/repo`, `${prefix}owner/${segment}`])
);

describe('parseGithubUrl', () => {
  it.each(validUrls)('preserves owner/repository casing for %s', (url) => {
    expect(parseGithubUrl(url)).toEqual({ owner: 'OwNeR-1', repo: 'RePo_2.name' });
  });

  it.each(invalidUrls)('rejects malformed path segments in %s', (url) => {
    expect(parseGithubUrl(url)).toBeNull();
  });

  it('accepts single-character names and internal dots', () => {
    expect(parseGithubUrl('https://github.com/A/B')).toEqual({ owner: 'A', repo: 'B' });
    expect(parseGithubUrl('https://github.com/owner..name/repo..name')).toEqual({
      owner: 'owner..name',
      repo: 'repo..name',
    });
  });

  it.each([
    '',
    'https://gitlab.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/owner/repo?tab=readme',
    'https://github.com/owner/repo#readme',
    'ssh://git@github.com/owner/repo',
    'https://github.com//repo',
    'https://github.com/owner/',
  ])('rejects unsupported URL shapes: %s', (url) => {
    expect(parseGithubUrl(url)).toBeNull();
  });
});
