import { expect, it } from 'vitest';
import {
  getProjectAgentPath,
  getProjectSection,
  getProjectSectionPath,
  hasExplicitLegacyProjectOwner,
} from './project-navigation';

it('encodes path segments and recognizes only complete canonical sections', () => {
  expect(getProjectAgentPath('a/b', 'c/d')).toBe('/projects/a%2Fb/agents/c%2Fd');
  expect(getProjectSectionPath('space here', 'reviews')).toBe('/projects/space%20here/reviews');
  expect(getProjectSection('/projects/a/agents/id')).toBe('agents');
  expect(getProjectSection('/projects/a/reviews')).toBe('reviews');
  expect(getProjectSection('/projects/a/agents-other')).toBeNull();
  expect(getProjectSection('/agents')).toBeNull();
});
it.each([
  ['/agents/archived-agent', '', true],
  ['/AGENTS/archived-agent/', '', true],
  ['/agents', '', false],
  ['/reviews', '?repo=owner%2Frepo&pr=12', true],
  ['/Reviews/', '?repo=owner%2Frepo&pr=12', true],
  ['/reviews', '', false],
  ['/admin', '?repo=owner/repo', false],
])(
  'keeps explicit legacy owner resolution eligible with no active projects: %s%s',
  (pathname, search, explicit) => {
    expect(hasExplicitLegacyProjectOwner(pathname, search)).toBe(explicit);
  }
);
