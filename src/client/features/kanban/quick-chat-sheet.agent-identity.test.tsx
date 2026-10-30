// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { QuickChatSheet } from './quick-chat-sheet';

const sessions = vi.hoisted(() => {
  const base = {
    workspaceId: 'workspace',
    workspacePrId: null,
    model: 'sonnet',
    provider: 'CLAUDE',
    providerSessionId: null,
    providerProjectPath: null,
    providerProcessPid: null,
    providerMetadata: null,
    createdAt: new Date('2026-10-27T12:00:00Z'),
    updatedAt: new Date('2026-10-27T12:00:00Z'),
    isWorking: false,
  };
  return [
    {
      ...base,
      id: 'legacy',
      name: 'Periodic task',
      workflow: 'periodic-task',
      status: 'RUNNING',
      isWorking: true,
    },
    { ...base, id: 'new', name: 'Agent', workflow: 'periodic-task', status: 'IDLE' },
    {
      ...base,
      id: 'custom',
      name: 'Dependency review',
      workflow: 'periodic-task',
      status: 'FAILED',
    },
    { ...base, id: 'ordinary', name: 'Periodic task', workflow: 'followup', status: 'IDLE' },
  ];
});

vi.mock('./kanban-context', () => ({
  useKanban: () => ({ workspaces: [{ id: 'workspace', name: 'Review workspace' }] }),
}));
vi.mock('./quick-chat-content', () => ({ QuickChatContent: () => null }));
vi.mock('@/client/features/workspace', () => ({ QuickActionsMenu: () => null }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: { get: { useQuery: () => ({ data: { defaultSessionProvider: 'CLAUDE' } }) } },
    session: { listSessions: { useQuery: () => ({ data: sessions }) } },
  },
}));
vi.mock('@/client/features/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/features/chat')>()),
  useChatWebSocket: () => ({}),
  useSessionCollectionCommands: () => ({
    createSession: { isPending: false },
    deleteSession: { mutate: vi.fn() },
    createChat: vi.fn(),
    createQuickAction: vi.fn(),
  }),
}));

it('renders scheduled session identity in quick-chat tabs', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
    );
    const tabs = document.body.querySelectorAll('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual([
      'Agent',
      'Agent',
      'Dependency review',
      'Periodic task',
    ]);
    expect(
      tabs[0]?.querySelector('[aria-label="Agent: Running"]')?.classList.contains('text-brand')
    ).toBe(true);
    expect(
      tabs[1]?.querySelector('[aria-label="Agent: Idle"]')?.classList.contains('text-emerald-500')
    ).toBe(true);
    expect(
      tabs[2]?.querySelector('[aria-label="Agent: Failed"]')?.classList.contains('text-destructive')
    ).toBe(true);
    expect(tabs[3]?.querySelector('[aria-label^="Agent:"]')).toBeNull();
    expect(tabs[3]?.querySelector('svg')?.classList.contains('text-emerald-500')).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
