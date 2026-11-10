import { type QueryClient, useMutationState } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import { getMutationKey } from '@trpc/react-query';
import type { UseTRPCQueryResult } from '@trpc/react-query/shared';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { type AppRouter, trpc } from '@/client/lib/trpc';

/**
 * The only place that reads and writes the `userSettings.get` cache and runs
 * `userSettings.update`. `factory/query-owner` keeps other files on these
 * hooks, so every settings control shares one cache strategy:
 *
 * - Writes run one at a time, in the order they were made (one mutation scope).
 * - Each write patches the cache before the request, so a control shows its
 *   new value immediately; a failure restores the fields it patched unless a
 *   newer pending write owns them, and shows one error toast.
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

function updateMutationKey() {
  return getMutationKey(trpc.userSettings.update);
}

/** Variables of every settings write that has not settled, including this one. */
function pendingPatches(client: QueryClient): unknown[] {
  return client
    .getMutationCache()
    .findAll({ mutationKey: updateMutationKey(), status: 'pending' })
    .map((mutation) => mutation.state.variables);
}

function patchesKey(patch: unknown, key: string): boolean {
  return typeof patch === 'object' && patch !== null && key in patch;
}

/** Restores the fields `patch` changed, except those a newer pending write also changes. */
function restorePatchedFields<T extends object>(
  current: T,
  previous: T,
  patch: Partial<T>,
  others: unknown[]
): T {
  const next = { ...current };
  for (const key in patch) {
    if (!others.some((other) => patchesKey(other, key))) {
      next[key] = previous[key];
    }
  }
  return next;
}

/**
 * Saves a partial settings update. Controls bound to `useUserSettings` data
 * flip immediately; `isSaving(field)` is true while a write of that field is
 * pending anywhere in the app.
 */
export function useUpdateUserSettings() {
  const utils = trpc.useUtils();
  const mutation = trpc.userSettings.update.useMutation({
    scope: { id: 'user-settings' },
    onMutate: async (patch) => {
      // An older read must not overwrite the optimistic value when it lands.
      await utils.userSettings.get.cancel();
      const previous = utils.userSettings.get.getData();
      utils.userSettings.get.setData(undefined, (current) =>
        current ? { ...current, ...patch } : current
      );
      return { previous };
    },
    onError: (error, patch, saved, { client }) => {
      const previous = saved?.previous;
      if (previous) {
        const others = pendingPatches(client).filter((other) => other !== patch);
        utils.userSettings.get.setData(undefined, (current) =>
          current ? restorePatchedFields(current, previous, patch, others) : current
        );
      }
      toast.error(SAVE_SETTINGS_ERROR, { id: SAVE_SETTINGS_ERROR, description: error.message });
    },
    onSettled: (settings, _error, _patch, _saved, { client }) => {
      // Earlier results would hide newer optimistic values; the last write
      // returns every saved field.
      if (client.isMutating({ mutationKey: updateMutationKey() }) > 1) {
        return;
      }
      if (settings) {
        utils.userSettings.get.setData(undefined, settings);
      }
      runInBackground(utils.userSettings.get.invalidate(), "Couldn't refresh settings.");
    },
  });
  const saving = useMutationState({
    filters: { mutationKey: updateMutationKey(), status: 'pending' },
    select: (pending) => pending.state.variables,
  });
  const isSaving = (field: keyof UserSettingsPatch) =>
    saving.some((patch) => patchesKey(patch, field));
  return { ...mutation, isSaving };
}
