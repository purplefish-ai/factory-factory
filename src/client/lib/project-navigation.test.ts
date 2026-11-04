import { expect, it } from 'vitest';
import {
  getProjectAgentPath,
  getProjectSection,
  getProjectNewWorkspacePath,
  getProjectSectionPath,
  hasExplicitLegacyProjectOwner,
  isProjectBoardPath,
} from './project-navigation';

it('encodes path segments and recognizes only complete canonical sections', () => {
  expect(getProjectAgentPath('a/b', 'c/d')).toBe('/projects/a%2Fb/agents/c%2Fd');
  expect(getProjectSectionPath('space here', 'reviews')).toBe('/projects/space%20here/reviews');
  expect(getProjectSection('/projects/a/agents/id')).toBe('agents');
  expect(getProjectSection('/PROJECTS/a/AGENTS/id')).toBe('agents');
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
it('keeps scheduled URLs stable and encodes saved event selections', () => {
  expect(getProjectAgentPath('a/b', 'c/d', 'event')).toBe(
    '/projects/a%2Fb/agents/c%2Fd?kind=event'
  );
  expect(getProjectAgentPath('a/b', 'c/d', 'scheduled')).toBe('/projects/a%2Fb/agents/c%2Fd');
});
it('recognizes only the board itself, not workspace detail or creation routes', () => {
  expect(isProjectBoardPath('/projects/a/workspaces')).toBe(true);
  expect(isProjectBoardPath('/projects/a/workspaces/')).toBe(true);
  expect(isProjectBoardPath('/PROJECTS/a/WORKSPACES')).toBe(true);
  expect(isProjectBoardPath('/projects/a/workspaces/ws-1')).toBe(false);
  expect(isProjectBoardPath('/projects/a/workspaces/new')).toBe(false);
  expect(isProjectBoardPath('/projects/a/agents')).toBe(false);
  expect(isProjectBoardPath('/projects/a')).toBe(false);
});
it('builds the board URL that opens the new workspace form', () => {
  expect(getProjectNewWorkspacePath('a/b')).toBe('/projects/a%2Fb/workspaces?new=1');
});
