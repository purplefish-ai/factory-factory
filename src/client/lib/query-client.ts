import { type Mutation, MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { withErrorToastDefaults } from '@/components/ui/sonner';

/**
 * Mutation `meta` understood by the app's MutationCache.
 *
 * `errorToast` controls the fallback error toast:
 * - omitted: a failure shows a generic "Couldn't complete that action" toast
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

export const DEFAULT_MUTATION_ERROR_TITLE = "Couldn't complete that action";

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
      },
    },
  });
}
