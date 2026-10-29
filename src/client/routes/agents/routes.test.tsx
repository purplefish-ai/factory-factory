// @vitest-environment jsdom
import { matchRoutes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// Route matching does not need application providers or their live queries.
vi.mock('@/client/root', () => ({ Root: () => null }));
vi.mock('@/client/layouts/project-layout', () => ({ ProjectLayout: () => null }));
import { router } from '@/client/router';

describe('Agents routes', () => {
  it.each([
    '/agents',
    '/agents/agent-id',
    '/projects/example/agents',
    '/projects/example/agents/agent-id',
  ])('registers the management page at %s', (pathname) => {
    const matches = matchRoutes(router.routes, pathname);
    expect(matches?.at(-1)?.route.path).toBe('agents/:id?');
    expect(matches?.at(-1)?.route.element).toBeTruthy();
  });
  it('preserves the explicitly requested ID and rejects additional path segments', () => {
    expect(matchRoutes(router.routes, '/agents/missing-id')?.at(-1)?.params.id).toBe('missing-id');
    expect(matchRoutes(router.routes, '/agents/agent-id/extra')).toBeNull();
    expect(matchRoutes(router.routes, '/projects/example/agents/agent-id/extra')).toBeNull();
    expect(matchRoutes(router.routes, '/projects/example/reviews')?.at(-1)?.route.path).toBe(
      'reviews'
    );
  });
});
