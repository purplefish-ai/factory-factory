import { describe, expect, it } from 'vitest';
import { getSearchResultUrl } from './search-navigation';

describe('search navigation', () => {
  it('links conversation names to the exact session, including encoded identifiers', () => {
    expect(
      getSearchResultUrl({
        kind: 'session',
        projectSlug: 'my project',
        workspaceId: 'ws/1',
        sessionId: 'chat?2',
      })
    ).toBe('/projects/my%20project/workspaces/ws%2F1?session=chat%3F2');
  });
  it('links projects to their board and workspaces to their detail', () => {
    expect(
      getSearchResultUrl({
        kind: 'project',
        projectSlug: 'factory',
        workspaceId: null,
        sessionId: null,
      })
    ).toBe('/projects/factory/workspaces');
    expect(
      getSearchResultUrl({
        kind: 'workspace',
        projectSlug: 'factory',
        workspaceId: 'ws1',
        sessionId: null,
      })
    ).toBe('/projects/factory/workspaces/ws1');
  });
});
