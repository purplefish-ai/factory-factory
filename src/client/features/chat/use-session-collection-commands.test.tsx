// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import { useSessionCollectionCommands } from '@/client/features/chat/use-session-collection-commands';

const { mutate, mutateAsync } = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    session: {
      createAndStartSession: { useMutation: () => ({ mutate, mutateAsync }) },
      deleteSession: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  vi.clearAllMocks();
});

type HarnessSession = { name?: string | null; provider?: 'CLAUDE' | 'CODEX'; model?: string };

function Harness({
  workspaceId,
  sessions,
  onCommands,
}: {
  workspaceId: string | null;
  sessions: HarnessSession[] | undefined;
  onCommands: (commands: ReturnType<typeof useSessionCollectionCommands>) => void;
}) {
  onCommands(useSessionCollectionCommands({ workspaceId, sessions, onCreated: vi.fn() }));
  return null;
}

function renderCommands(workspaceId: string | null, sessions: HarnessSession[] | undefined) {
  let commands: ReturnType<typeof useSessionCollectionCommands> | undefined;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  flushSync(() =>
    root.render(
      createElement(Harness, {
        workspaceId,
        sessions,
        onCommands: (value) => {
          commands = value;
        },
      })
    )
  );
  if (!commands) {
    throw new Error('Missing commands');
  }
  return commands;
}

const names = (values: Array<string | null>) => values.map((name) => ({ name }));

describe('useSessionCollectionCommands input policy', () => {
  it('does not create chats or quick actions without a workspace', async () => {
    const commands = renderCommands(null, []);
    commands.createChat();
    commands.createQuickAction('Review', 'Review prompt');
    await commands.createQuickActionAsync('Review', 'Review prompt');
    expect(mutate).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    { names: [], want: 'Chat 1' },
    { names: ['Chat 2', 'Chat 9', 'Chat 3'], want: 'Chat 10' },
    { names: [null, '', 'Review', 'Chat 0', 'Chat 99 extra', 'Chat -1'], want: 'Chat 1' },
  ])('numbers new chats from exact positive Chat N titles: $want', ({ names: titles, want }) => {
    renderCommands('workspace', names(titles)).createChat();
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'workspace', workflow: 'followup', name: want, initialPrompt: '' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

it("starts chats and quick actions with the workspace's first provider and model", async () => {
  mutateAsync.mockResolvedValue({ id: 'created' });
  const commands = renderCommands('workspace', [
    { name: 'Chat 1', provider: 'CODEX', model: 'gpt-sol' },
    { name: 'Chat 2', provider: 'CLAUDE', model: 'opus' },
  ]);
  commands.createChat();
  await commands.createQuickActionAsync('Review', 'Review prompt');
  expect(mutate).toHaveBeenCalledWith(
    {
      workspaceId: 'workspace',
      workflow: 'followup',
      provider: 'CODEX',
      model: 'gpt-sol',
      name: 'Chat 3',
      initialPrompt: '',
    },
    expect.anything()
  );
  expect(mutateAsync).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    workflow: 'followup',
    provider: 'CODEX',
    model: 'gpt-sol',
    name: 'Review',
    initialMessage: 'Review prompt',
    initialPrompt: '',
  });
});

it('does not launch chats or quick actions before sessions load', async () => {
  const commands = renderCommands('workspace', undefined);
  commands.createChat();
  commands.createQuickAction('Review', 'Review prompt');
  await commands.createQuickActionAsync('Review', 'Review prompt');
  expect(mutate).not.toHaveBeenCalled();
  expect(mutateAsync).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith('Sessions are still loading. Try again in a moment.');
});
