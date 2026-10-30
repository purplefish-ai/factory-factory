import type { inferRouterInputs } from '@trpc/server';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { type AppRouter, trpc } from '@/client/lib/trpc';

type CreateSessionInput = inferRouterInputs<AppRouter>['session']['createAndStartSession'];
interface CreatedSession {
  id: string;
  codexAccountId?: string | null;
}

type CreationKind = 'chat' | 'quick-action';
const SESSIONS_LOADING_MESSAGE = 'Sessions are still loading. Try again in a moment.';

interface CollectionSession {
  name?: string | null;
  provider?: CreateSessionInput['provider'];
  model?: string | null;
}

interface SessionCollectionCommandsOptions {
  workspaceId: string | null;
  /** Workspace sessions, oldest first. */
  sessions: readonly CollectionSession[] | undefined;
  workspaceProvider?: CreateSessionInput['provider'];
  onCreated: (session: CreatedSession, workspaceId: string, kind: CreationKind) => void;
}

/**
 * New conversations reuse the provider and model the workspace started with. Thinking and Plan
 * stay at their defaults; users change them per conversation in the composer.
 */
function getWorkspaceCreationDefaults(
  sessions: readonly CollectionSession[],
  workspaceProvider?: CreateSessionInput['provider']
): Pick<CreateSessionInput, 'provider' | 'model'> {
  const first = sessions[0];
  const provider = first?.provider ?? workspaceProvider;
  if (!provider) {
    return {};
  }
  return first?.model ? { provider, model: first.model } : { provider };
}

// Expose the collection capability without leaking tRPC's private inferred result types.
interface CollectionMutation<TInput, TOutput = unknown> {
  mutate: (
    input: TInput,
    options?: { onSuccess?: (data: TOutput) => void; onError?: (error: unknown) => void }
  ) => void;
  isPending: boolean;
}

interface SessionCollectionCommands {
  createSession: CollectionMutation<CreateSessionInput, CreatedSession>;
  deleteSession: CollectionMutation<{ id: string }>;
  createChat: (codexAccountId?: string) => void;
  createQuickAction: (name: string, prompt: string) => void;
  createQuickActionAsync: (name: string, prompt: string) => Promise<void>;
}

/** Collection writes and cache transactions, independent of selection and navigation policy. */
export function useSessionCollectionCommands({
  workspaceId,
  sessions,
  workspaceProvider,
  onCreated,
}: SessionCollectionCommandsOptions): SessionCollectionCommands {
  const utils = trpc.useUtils();
  const createSession = trpc.session.createAndStartSession.useMutation({
    onSuccess: (_session, variables) => {
      runInBackground(
        utils.session.listSessions.invalidate({ workspaceId: variables.workspaceId }),
        'Could not refresh data'
      );
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create or start session');
    },
  });
  const deleteSession = trpc.session.deleteSession.useMutation({
    onMutate: async ({ id }) => {
      // Capture before cancellation yields: this hook can render another workspace meanwhile.
      const operationWorkspaceId = workspaceId ?? '';
      const key = { workspaceId: operationWorkspaceId };
      await utils.session.listSessions.cancel(key);
      const previousSessions = utils.session.listSessions.getData(key);
      utils.session.listSessions.setData(key, (old) => old?.filter((session) => session.id !== id));
      return { workspaceId: operationWorkspaceId, previousSessions };
    },
    onError: (error, _variables, context) => {
      if (context?.previousSessions) {
        utils.session.listSessions.setData(
          { workspaceId: context.workspaceId },
          context.previousSessions
        );
      }
      toast.error(error.message || 'Failed to delete session');
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.workspaceId) {
        runInBackground(
          utils.session.listSessions.invalidate({ workspaceId: context.workspaceId }),
          'Could not refresh data'
        );
      }
    },
  });

  const createChat = useCallback(
    (codexAccountId?: string) => {
      if (!workspaceId) {
        return;
      }
      if (!sessions) {
        toast.error(SESSIONS_LOADING_MESSAGE);
        return;
      }
      const existingNumbers = sessions
        .map((session) => {
          const match = session.name?.match(/^Chat (\d+)$/);
          return match ? Number.parseInt(match[1] as string, 10) : 0;
        })
        .filter((number) => number > 0);
      const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
      createSession.mutate(
        {
          workspaceId,
          workflow: 'followup',
          ...getWorkspaceCreationDefaults(sessions, workspaceProvider),
          ...((sessions[0]?.provider ?? workspaceProvider) === 'CODEX' && codexAccountId
            ? { codexAccountId }
            : {}),
          name: `Chat ${nextNumber}`,
          initialPrompt: '',
        },
        { onSuccess: (session) => onCreated(session, workspaceId, 'chat') }
      );
    },
    [workspaceId, sessions, workspaceProvider, createSession, onCreated]
  );

  const quickActionInput = useCallback(
    (name: string, prompt: string): CreateSessionInput | null => {
      if (!workspaceId) {
        return null;
      }
      if (!sessions) {
        toast.error(SESSIONS_LOADING_MESSAGE);
        return null;
      }
      return {
        workspaceId,
        workflow: 'followup',
        ...getWorkspaceCreationDefaults(sessions, workspaceProvider),
        name,
        initialMessage: prompt,
        initialPrompt: '',
      };
    },
    [workspaceId, sessions, workspaceProvider]
  );
  const createQuickAction = useCallback(
    (name: string, prompt: string) => {
      const input = quickActionInput(name, prompt);
      if (input) {
        createSession.mutate(input, {
          onSuccess: (session) => onCreated(session, input.workspaceId, 'quick-action'),
        });
      }
    },
    [quickActionInput, createSession, onCreated]
  );
  const createQuickActionAsync = useCallback(
    async (name: string, prompt: string) => {
      const input = quickActionInput(name, prompt);
      if (!input) {
        return;
      }
      try {
        const session = await createSession.mutateAsync(input);
        onCreated(session, input.workspaceId, 'quick-action');
      } catch {
        // The mutation's onError handler reports the failure.
      }
    },
    [quickActionInput, createSession, onCreated]
  );

  return { createSession, deleteSession, createChat, createQuickAction, createQuickActionAsync };
}
