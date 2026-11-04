// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkspacesListPage from './list';
import NewWorkspaceRedirectPage from './new';

const mocks = vi.hoisted(() => ({
  boardProps: [] as Array<{ slug: string; openNewWorkspaceForm?: boolean }>,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      getBySlug: {
        useQuery: ({ slug }: { slug: string }) => ({
          data: { id: `${slug}-id`, name: slug, issueProvider: 'GITHUB' },
        }),
      },
    },
  },
}));
vi.mock('./use-workspace-project-navigation', () => ({
  useWorkspaceProjectNavigation: () => ({ slug: 'alpha', projects: [] }),
}));
vi.mock('./components', () => ({
  WorkspacesBoardView: ({
    slug,
    openNewWorkspaceForm,
    onNewWorkspaceFormOpened,
  }: {
    slug: string;
    openNewWorkspaceForm?: boolean;
    onNewWorkspaceFormOpened?: () => void;
  }) => {
    mocks.boardProps.push({ slug, openNewWorkspaceForm });
    useEffect(() => {
      if (openNewWorkspaceForm) {
        onNewWorkspaceFormOpened?.();
      }
    }, [openNewWorkspaceForm, onNewWorkspaceFormOpened]);
    return null;
  },
}));

function Location() {
  const { pathname, search } = useLocation();
  return (
    <output>
      {pathname}
      {search}
    </output>
  );
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Back
    </button>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.boardProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The retired URL is opened from another page so Back shows whether the
// redirect and the request cleanup replaced history entries or pushed them.
const PREVIOUS_PAGE = '/projects/alpha/agents';

async function renderAt(path: string, withBoard: boolean) {
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[PREVIOUS_PAGE, path]} initialIndex={1}>
        <Location />
        <BackButton />
        <Routes>
          <Route path="/projects/:slug/workspaces">
            <Route index element={withBoard ? <WorkspacesListPage /> : null} />
            <Route path="new" element={<NewWorkspaceRedirectPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  );
  return container.querySelector('output')?.textContent;
}

it.each([
  ['/projects/alpha/workspaces/new', '/projects/alpha/workspaces?new=1'],
  ['/projects/a%20b/workspaces/new', '/projects/a%20b/workspaces?new=1'],
])('redirects the retired form route %s to the board create request', async (path, expected) => {
  await expect(renderAt(path, false)).resolves.toBe(expected);
});

it('opens the board form for an old link and then drops the one-shot request', async () => {
  await expect(renderAt('/projects/alpha/workspaces/new', true)).resolves.toBe(
    '/projects/alpha/workspaces'
  );
  expect(mocks.boardProps).toContainEqual({ slug: 'alpha', openNewWorkspaceForm: true });
  expect(mocks.boardProps.at(-1)).toEqual({ slug: 'alpha', openNewWorkspaceForm: false });
});

async function goBack() {
  await act(() => container.querySelector<HTMLButtonElement>('button')?.click());
  return container.querySelector('output')?.textContent;
}

it.each([false, true])(
  'replaces the retired URL so Back returns to the previous page (board=%s)',
  async (withBoard) => {
    await renderAt('/projects/alpha/workspaces/new', withBoard);
    await expect(goBack()).resolves.toBe(PREVIOUS_PAGE);
  }
);
