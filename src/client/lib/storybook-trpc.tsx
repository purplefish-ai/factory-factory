import { QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { observable } from '@trpc/server/observable';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
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

/**
 * Converts a handler failure to what the real link would produce. Throw a
 * `TRPCError` to give the client an error code (`error.data.code`), as the
 * server would.
 */
function toClientError(error: unknown) {
  if (error instanceof TRPCClientError) {
    return error;
  }
  if (error instanceof TRPCError) {
    return TRPCClientError.from({
      error: {
        message: error.message,
        code: TRPC_ERROR_CODES_BY_KEY[error.code],
        data: { code: error.code, httpStatus: getHTTPStatusCodeFromError(error) },
      },
    });
  }
  return new TRPCClientError(error instanceof Error ? error.message : String(error), {
    cause: error instanceof Error ? error : undefined,
  });
}

export function createStoryTrpcClient({ handlers = {}, onRequest }: StoryTrpcOptions = {}) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            onRequest?.(op.path, op.input);
            const handler = Object.hasOwn(handlers, op.path) ? handlers[op.path] : undefined;
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

/**
 * Reads `parameters.trpc.handlers` from a story context. Throws on a malformed
 * value so a typo fails the story instead of silently leaving every request
 * pending.
 */
export function storyTrpcHandlersFrom(parameters: unknown): StoryTrpcHandlers | undefined {
  if (typeof parameters !== 'object' || parameters === null || !('trpc' in parameters)) {
    return undefined;
  }
  const { trpc: trpcParameters } = parameters;
  if (trpcParameters === undefined) {
    return undefined;
  }
  if (typeof trpcParameters !== 'object' || trpcParameters === null) {
    throw new Error('parameters.trpc must be an object with a `handlers` record.');
  }
  if (!('handlers' in trpcParameters) || trpcParameters.handlers === undefined) {
    return undefined;
  }
  if (!isHandlerRecord(trpcParameters.handlers)) {
    throw new Error(
      'parameters.trpc.handlers must map procedure paths to functions, for example ' +
        "{ 'userSettings.get': () => settings }."
    );
  }
  return trpcParameters.handlers;
}
