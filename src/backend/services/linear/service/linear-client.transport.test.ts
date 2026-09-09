import { afterEach, expect, it, vi } from 'vitest';
import { linearClientService } from './linear-client.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

function response(data: unknown): Response {
  return Response.json({ data });
}

it('authenticates and resolves issue relations through the actual SDK transport', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({
        issue: {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Test issue',
          description: null,
          url: 'https://linear.app/test/issue/ENG-1',
          createdAt: '2026-09-09T12:00:00Z',
          state: { id: 'state-1' },
          creator: { id: 'user-1' },
          reactions: [],
          sharedAccess: {
            isShared: false,
            sharedWithCount: 0,
            viewerHasOnlySharedAccess: false,
            disallowedIssueFields: [],
            sharedWithUsers: [],
          },
        },
      })
    )
    .mockResolvedValueOnce(response({ workflowState: { id: 'state-1', name: 'Todo' } }))
    .mockResolvedValueOnce(
      response({ user: { id: 'user-1', name: 'Jane', displayName: 'Jane Doe' } })
    );
  vi.stubGlobal('fetch', fetch);

  expect(await linearClientService.getIssue('fixture-key', 'issue-1')).toEqual({
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    description: '',
    url: 'https://linear.app/test/issue/ENG-1',
    createdAt: '2026-09-09T12:00:00.000Z',
    state: 'Todo',
    creatorName: 'Jane Doe',
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('fixture-key');
  }
});

it('returns an invalid key result for a GraphQL authentication error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          errors: [
            { message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } },
          ],
        },
        { status: 401 }
      )
    )
  );
  expect(await linearClientService.validateApiKey('fixture-invalid-key')).toEqual({
    valid: false,
    error: expect.stringContaining('Authentication required'),
  });
});
