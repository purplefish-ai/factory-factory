import { QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useState } from 'react';
import { createAppQueryClient } from './query-client';
import { trpc } from './trpc';

/**
 * Storybook-only tRPC transport. Stories never reach a backend: each procedure
 * path is answered by a story handler, and unhandled requests stay pending so
 * the component shows a stable loading state instead of a network error.
 * See docs/storybook.md#mocking-data.
 */

/** Return this from a handler to keep that request pending (a loading state). */
export const STORY_TRPC_PENDING = Symbol('story-trpc-pending');

/**
 * Answers one procedure. Return the procedure's output (or a promise of it),
 * throw to fail the request, or return {@link STORY_TRPC_PENDING}.
 */
export type StoryTrpcHandler = (input: unknown) => unknown;

/** Handlers keyed by procedure path, such as `userSettings.get`. */
export type StoryTrpcHandlers = Readonly<Record<string, StoryTrpcHandler>>;

export interface StoryTrpcOptions {
  handlers?: StoryTrpcHandlers;
  /** Called for every request, before its handler; useful with `fn()`. */
  onRequest?: (path: string, input: unknown) => void;
}

function toClientError(error: unknown) {
  if (error instanceof TRPCClientError) {
    return error;
  }
  return new TRPCClientError(error instanceof Error ? error.message : String(error));
}

export function createStoryTrpcClient({ handlers = {}, onRequest }: StoryTrpcOptions = {}) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            onRequest?.(op.path, op.input);
            const handler = handlers[op.path];
            if (!handler) {
              return;
            }
            let active = true;
            Promise.resolve()
              .then(() => handler(op.input))
              .then(
                (data) => {
                  if (!active || data === STORY_TRPC_PENDING) {
                    return;
                  }
                  observer.next({ result: { data } });
                  observer.complete();
                },
                (error: unknown) => {
                  if (active) {
                    observer.error(toClientError(error));
                  }
                }
              );
            return () => {
              active = false;
            };
          }),
    ],
  });
}

/**
 * The app's QueryClient (including its fallback mutation error toast) without
 * retries, so failing handlers show their error state immediately.
 */
function createStoryQueryClient() {
  const queryClient = createAppQueryClient();
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
    mutations: { ...defaults.mutations, retry: false },
  });
  return queryClient;
}

/** Story-scoped tRPC and React Query providers backed by {@link createStoryTrpcClient}. */
export function StoryTrpcProvider({
  children,
  handlers,
  onRequest,
}: StoryTrpcOptions & { children: ReactNode }) {
  const [queryClient] = useState(createStoryQueryClient);
  const [client] = useState(() => createStoryTrpcClient({ handlers, onRequest }));
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

function isHandlerRecord(value: unknown): value is StoryTrpcHandlers {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((handler) => typeof handler === 'function')
  );
}

/** Reads `parameters.trpc.handlers` from a story context, ignoring malformed values. */
export function storyTrpcHandlersFrom(parameters: unknown): StoryTrpcHandlers | undefined {
  if (typeof parameters !== 'object' || parameters === null || !('trpc' in parameters)) {
    return undefined;
  }
  const { trpc: trpcParameters } = parameters;
  if (
    typeof trpcParameters !== 'object' ||
    trpcParameters === null ||
    !('handlers' in trpcParameters)
  ) {
    return undefined;
  }
  return isHandlerRecord(trpcParameters.handlers) ? trpcParameters.handlers : undefined;
}
