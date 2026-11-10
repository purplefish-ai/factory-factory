// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitProbe } from '@/test-utils/commit-probe';
import { useAgentsController } from './use-agents-controller';

vi.mock('@/client/lib/trpc', () => {
  const query = { data: undefined, isSuccess: false, error: null, isLoading: false };
  const mutation = { isPending: false, mutateAsync: vi.fn() };
  return {
    trpc: {
      useUtils: () => ({}),
      periodicTask: {
        get: { useQuery: () => query },
        list: { useQuery: () => query },
        create: { useMutation: () => mutation },
        update: { useMutation: () => mutation },
        toggleEnabled: { useMutation: () => mutation },
        delete: { useMutation: () => mutation },
      },
      automation: {
        list: { useInfiniteQuery: () => query },
        get: { useQuery: () => query },
      },
    },
  };
});

const project = { id: 'project', name: 'Project', slug: 'project' };
let controller: ReturnType<typeof useAgentsController> | undefined;
let navigateTo: ((path: string) => void) | undefined;
const committed: Array<{ id: string | undefined; mode: string; deleteOpen: boolean }> = [];

function Harness() {
  const current = useAgentsController(project);
  controller = current;
  const navigate = useNavigate();
  navigateTo = (path) => {
    void navigate(path);
  };
  return (
    <CommitProbe
      onCommit={() =>
        committed.push({ id: current.id, mode: current.mode, deleteOpen: current.deleteOpen })
      }
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  committed.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAgentsController', () => {
  it('closes the editor and delete dialog in the first commit for another agent', () => {
    const root = createRoot(document.createElement('div'));
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/projects/project/agents/first']}>
          <Routes>
            <Route path="/projects/:slug/agents/:id?" element={<Harness />} />
          </Routes>
        </MemoryRouter>
      )
    );
    act(() => {
      controller?.setMode('edit');
      controller?.setDeleteOpen(true);
    });
    expect(committed.at(-1)).toEqual({ id: 'first', mode: 'edit', deleteOpen: true });

    const before = committed.length;
    act(() => navigateTo?.('/projects/project/agents/second'));
    expect(committed.slice(before)).toEqual([{ id: 'second', mode: 'detail', deleteOpen: false }]);
    act(() => root.unmount());
  });
});
