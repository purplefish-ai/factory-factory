import type { TRPCClientErrorLike } from '@trpc/client';
import { getMutationKey } from '@trpc/react-query';
import type { UseTRPCQueryResult } from '@trpc/react-query/shared';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import {
  createPatchRollback,
  pendingPatches,
  useSavingFields,
} from '@/client/lib/optimistic-patch';
import { QUERY_RETRY } from '@/client/lib/query-options';
import { type AppRouter, trpc } from '@/client/lib/trpc';

/**
 * The only place that reads and writes the `userSettings.get` cache and runs
 * `userSettings.update`, and the only reader of `userSettings.getProviderOptions`. `factory/query-owner` keeps other files on these
 * hooks, so every settings control shares one cache strategy:
 *
 * - Writes run one at a time, in the order they were made (one mutation scope).
 * - Each write patches the cache before the request, so a control shows its
 *   new value immediately; a failure restores the fields it patched (a newer
 *   pending write of the same field inherits the value to restore) and shows
 *   one error toast.
 * - When the last pending write settles, the saved settings are committed and
 *   refetched, so the page converges on the server's values.
 */

export type UserSettings = inferRouterOutputs<AppRouter>['userSettings']['get'];
export type UserSettingsPatch = inferRouterInputs<AppRouter>['userSettings']['update'];

export const SAVE_SETTINGS_ERROR = "Couldn't save settings.";

interface UserSettingsQueryOptions {
  enabled?: boolean;
  staleTime?: number;
}

/** The user's settings. Pass `enabled` or `staleTime` when a reader needs them. */
export function useUserSettings(
  options?: UserSettingsQueryOptions
): UseTRPCQueryResult<UserSettings, TRPCClientErrorLike<AppRouter>> {
  return trpc.userSettings.get.useQuery(undefined, options);
}

export type ProviderOptions = inferRouterOutputs<AppRouter>['userSettings']['getProviderOptions'];
type ProviderOptionsInput = inferRouterInputs<AppRouter>['userSettings']['getProviderOptions'];

/** Live model discovery starts provider processes, so every reader shares one freshness window. */
const PROVIDER_OPTIONS_STALE_TIME_MS = 60_000;

interface ProviderOptionsQueryOptions {
  enabled?: boolean;
  refetchOnWindowFocus?: boolean;
  refetchInterval?: (query: { state: { data: ProviderOptions | undefined } }) => number | false;
}

/**
 * The provider model catalog, optionally for one Codex account. Each attempt
 * runs discovery, so a failure is not retried automatically; readers retry
 * from their UI or their next poll.
 */
export function useProviderOptions(
  input?: ProviderOptionsInput,
  options?: ProviderOptionsQueryOptions
): UseTRPCQueryResult<ProviderOptions, TRPCClientErrorLike<AppRouter>> {
  return trpc.userSettings.getProviderOptions.useQuery(input, {
    ...options,
    staleTime: PROVIDER_OPTIONS_STALE_TIME_MS,
    retry: QUERY_RETRY.costlyRead,
  });
}

const rollback = createPatchRollback<UserSettings>();

/** Settings other caches derive from, refreshed after each saved write that changes them. */
const IDE_FIELDS = ['preferredIde', 'customIdeCommand'] as const;

/**
 * Saves a partial settings update. Controls bound to `useUserSettings` data
 * flip immediately; `isSaving(field)` is true while a write of that field is
 * pending anywhere in the app.
 */
export function useUpdateUserSettings() {
  const utils = trpc.useUtils();
  const mutationKey = getMutationKey(trpc.userSettings.update);
  const mutation = trpc.userSettings.update.useMutation({
    scope: { id: 'user-settings' },
    onMutate: async (patch) => {
      // An older read must not overwrite the optimistic value when it lands.
      await utils.userSettings.get.cancel();
      const previous = utils.userSettings.get.getData();
      if (previous) {
        rollback.remember(patch, previous);
      }
      utils.userSettings.get.setData(undefined, (current) =>
        current ? { ...current, ...patch } : current
      );
    },
    onError: (error, patch, _context, { client }) => {
      utils.userSettings.get.setData(undefined, (current) =>
        current ? rollback.restore(current, patch, pendingPatches(client, mutationKey)) : current
      );
      toast.error(SAVE_SETTINGS_ERROR, { id: SAVE_SETTINGS_ERROR, description: error.message });
    },
    onSuccess: (_settings, patch) => {
      if (IDE_FIELDS.some((field) => patch[field] !== undefined)) {
        runInBackground(utils.workspace.getAvailableIdes.invalidate(), "Couldn't refresh IDEs.");
      }
    },
    onSettled: (settings, _error, _patch, _context, { client }) => {
      // Earlier results would hide newer optimistic values; the last write
      // returns every saved field.
      if (client.isMutating({ mutationKey }) > 1) {
        return;
      }
      if (settings) {
        utils.userSettings.get.setData(undefined, settings);
      }
      runInBackground(utils.userSettings.get.invalidate(), "Couldn't refresh settings.");
    },
  });
  const isSaving: (field: keyof UserSettingsPatch) => boolean = useSavingFields(mutationKey);
  return { ...mutation, isSaving };
}
