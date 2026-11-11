import { type Mutation, MutationCache, QueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { z } from 'zod';
import { withErrorToastDefaults } from '@/components/ui/sonner';

/**
 * Mutation `meta` understood by the app's MutationCache.
 *
 * `errorToast` controls the fallback error toast:
 * - omitted: a failure shows a generic "Couldn't complete that action." toast
 *   (unless the mutation has an options-level `onError`).
 * - string: a failure shows a toast with this title and the server message as
 *   the description.
 * - `false`: the call site reports failures itself, through a per-call
 *   `mutate(vars, { onError })`, a `mutateAsync` try/catch, or inline error UI.
 */
export interface AppMutationMeta extends Record<string, unknown> {
  errorToast?: string | false;
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: AppMutationMeta;
  }
}

export const DEFAULT_MUTATION_ERROR_TITLE = "Couldn't complete that action.";

function describeError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message || undefined;
  }
  if (typeof error === 'string') {
    return error || undefined;
  }
  return undefined;
}

/**
 * Fallback for mutations that would otherwise fail silently.
 *
 * The cache only sees options passed to `useMutation(...)`. Per-call callbacks
 * (`mutate(vars, { onError })`) live on the MutationObserver and a
 * `mutateAsync` rejection goes to the caller, so neither is visible here. The
 * rule is therefore: toast unless the mutation has an options-level `onError`
 * or opts out with `meta: { errorToast: false }`. Call sites that handle errors
 * per call or with `mutateAsync` must set that opt-out.
 */
export function handleMutationError(
  error: unknown,
  mutation: Pick<Mutation<unknown, unknown, unknown>, 'options'>
): void {
  if (typeof mutation.options.onError === 'function') {
    return;
  }
  const errorToast = mutation.options.meta?.errorToast;
  if (errorToast === false) {
    return;
  }
  const title = typeof errorToast === 'string' ? errorToast : DEFAULT_MUTATION_ERROR_TITLE;
  const description = describeError(error);
  toast.error(title, withErrorToastDefaults(description ? { description } : undefined));
}

/**
 * Retries after the first failure. Two retries with TanStack's exponential
 * backoff (1 s, then 2 s) ride out a backend restart or a dropped connection
 * while still showing the error within about three seconds.
 */
export const MAX_QUERY_RETRIES = 2;

const trpcErrorDataSchema = z.object({ httpStatus: z.number().int() });

/** The HTTP status the server attached to a tRPC error, if any. */
function trpcHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof TRPCClientError)) {
    return undefined;
  }
  const data = trpcErrorDataSchema.safeParse(error.data);
  return data.success ? data.data.httpStatus : undefined;
}

/**
 * Default query retry policy. A 4xx answer (not found, forbidden, invalid
 * input, precondition failed) will not change on retry, so it surfaces at
 * once. Network failures, server errors and non-tRPC errors retry up to
 * `MAX_QUERY_RETRIES` times.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = trpcHttpStatus(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) => {
        handleMutationError(error, mutation);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5 * 1000, // 5 seconds
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
    },
  });
}
