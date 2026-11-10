// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, matchRoutes, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorFallback, routeErrorToError } from './route-error-fallback';
import NotFoundPage from './routes/not-found';

// Route matching does not need application providers or their live queries.
vi.mock('@/client/root', () => ({ Root: () => null }));
vi.mock('@/client/layouts/project-layout', () => ({ ProjectLayout: () => null }));
import { router } from '@/client/router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderAt(pathname: string) {
  const memoryRouter = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <div data-testid="shell">
            <Outlet />
          </div>
        ),
        errorElement: <RouteErrorFallback />,
        children: [
          {
            path: 'broken',
            loader: () => {
              throw new Response('', { status: 503, statusText: 'Service Unavailable' });
            },
            element: null,
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { initialEntries: [pathname] }
  );
  await act(async () => {
    root.render(<RouterProvider router={memoryRouter} />);
    await Promise.resolve();
  });
}

describe('app routes', () => {
  const rootRoute = router.routes.find((route) => route.path === '/');

  it('renders route errors with the shared fallback instead of the router default', () => {
    expect(rootRoute?.errorElement).toBeDefined();
  });

  it.each(['/does-not-exist', '/projects/example/unknown', '/admin/logs/extra'])(
    'sends %s to the not-found page inside the shell',
    (pathname) => {
      const matches = matchRoutes(router.routes, pathname);
      expect(matches?.[0]?.route).toBe(rootRoute);
      expect(matches?.at(-1)?.route.path).toBe('*');
    }
  );
});

describe('NotFoundPage', () => {
  it('names the missing path inside the shell and links home', async () => {
    await renderAt('/missing/page');
    const shell = container.querySelector('[data-testid="shell"]');
    expect(shell?.textContent).toContain('Page not found');
    expect(shell?.textContent).toContain('/missing/page');
    expect(shell?.querySelector('a')?.getAttribute('href')).toBe('/');
  });
});

describe('RouteErrorFallback', () => {
  it('shows a router error response with Reload and Copy details', async () => {
    await renderAt('/broken');
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't show this page");
    expect(alert?.textContent).toContain('503 Service Unavailable');
    expect(alert?.textContent).toContain('Reload');
    expect(alert?.textContent).toContain('Copy details');
  });

  it('normalizes thrown errors and non-errors', () => {
    const error = new Error('boom');
    expect(routeErrorToError(error)).toBe(error);
    expect(routeErrorToError('text failure').message).toBe('text failure');
    expect(routeErrorToError(null).message).toBe('An unexpected error occurred.');
  });
});
