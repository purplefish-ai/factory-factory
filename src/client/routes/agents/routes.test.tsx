// @vitest-environment jsdom
import { matchRoutes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// Route matching does not need application providers or their live queries.
vi.mock('@/client/root', () => ({ Root: () => null }));
vi.mock('@/client/layouts/project-layout', () => ({ ProjectLayout: () => null }));
import { router } from '@/client/router';

describe('Agents routes', () => {
  const rootRoute = router.routes.find((route) => route.path === '/');
  const legacy = rootRoute?.children?.find((route) => route.path === 'agents/:id?');
  const canonical = rootRoute?.children
    ?.find((route) => route.path === 'projects')
    ?.children?.find((route) => route.path === ':slug')
    ?.children?.find((route) => route.path === 'agents/:id?');
  it.each([
    ['/agents', 'legacy'],
    ['/agents/agent-id', 'legacy'],
    ['/projects/example/agents', 'canonical'],
    ['/projects/example/agents/agent-id', 'canonical'],
  ])('matches %s to the %s Agents route', (pathname, kind) => {
    const expected = kind === 'legacy' ? legacy : canonical;
    expect(expected).toBeDefined();
    expect(matchRoutes(router.routes, pathname)?.at(-1)?.route).toBe(expected);
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
