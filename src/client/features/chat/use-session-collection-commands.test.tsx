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

function Harness({
  workspaceId,
  names,
  onCommands,
  canCreate,
}: {
  workspaceId: string | null;
  canCreate?: boolean;
  names: Array<string | null>;
  onCommands: (commands: ReturnType<typeof useSessionCollectionCommands>) => void;
}) {
  onCommands(
    useSessionCollectionCommands({
      workspaceId,
      sessions: names.map((name) => ({ name })),
      creationDefaults: { model: '' },
      canCreate,
      onCreated: vi.fn(),
    })
  );
  return null;
}

function renderCommands(
  workspaceId: string | null,
  names: Array<string | null> = [],
  canCreate = true
) {
  let commands: ReturnType<typeof useSessionCollectionCommands> | undefined;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  flushSync(() =>
    root.render(
      createElement(Harness, {
        workspaceId,
        names,
        canCreate,
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

describe('useSessionCollectionCommands input policy', () => {
  it('does not create chats or quick actions without a workspace', async () => {
    const commands = renderCommands(null);
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
  ])('numbers new chats from exact positive Chat N titles: $want', ({ names, want }) => {
    renderCommands('workspace', names).createChat();
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'workspace', workflow: 'followup', model: '', name: want, initialPrompt: '' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

it('does not launch chats or quick actions before creation defaults are available', async () => {
  const commands = renderCommands('workspace', [], false);
  commands.createChat();
  commands.createQuickAction('Review', 'Review prompt');
  await commands.createQuickActionAsync('Review', 'Review prompt');
  expect(mutate).not.toHaveBeenCalled();
  expect(mutateAsync).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith('Chat defaults are not ready. Wait or retry selection.');
});
