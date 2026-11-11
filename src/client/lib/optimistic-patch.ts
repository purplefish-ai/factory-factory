import { type MutationKey, type QueryClient, useMutationState } from '@tanstack/react-query';

/**
 * Helpers for mutations that save a partial patch of one cached object,
 * apply it optimistically, and run one at a time in a shared scope.
 */

function patchesField(patch: unknown, field: string): boolean {
  return typeof patch === 'object' && patch !== null && field in patch;
}

/** Variables of every pending mutation under `mutationKey`, oldest first. */
export function pendingPatches(client: QueryClient, mutationKey: MutationKey): unknown[] {
  return client
    .getMutationCache()
    .findAll({ mutationKey, status: 'pending' })
    .map((mutation) => mutation.state.variables);
}

/** `isSaving(field)`: whether any pending mutation under `mutationKey` writes `field`. */
export function useSavingFields(mutationKey: MutationKey): (field: string) => boolean {
  const pending = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => mutation.state.variables,
  });
  return (field) => pending.some((patch) => patchesField(patch, field));
}

function isField<T extends object>(value: T, field: string): field is Extract<keyof T, string> {
  return field in value;
}

/**
 * Remembers what each optimistic patch replaced, so a failed patch can be
 * rolled back field by field without undoing newer pending patches.
 */
export function createPatchRollback<T extends object>() {
  const replaced = new WeakMap<object, T>();
  /** The newer pending patch that also writes `field`, and what it replaced. */
  const heirOf = (newer: unknown[], field: string) => {
    const heir = newer.find((other) => patchesField(other, field));
    return {
      heir,
      heirReplaced: typeof heir === 'object' && heir !== null ? replaced.get(heir) : undefined,
    };
  };
  return {
    /** Call before applying `patch` (the mutation variables) with the value it replaces. */
    remember(patch: object, previous: T) {
      replaced.set(patch, { ...previous });
    },
    /**
     * Restores the fields `patch` changed. A field that a newer pending patch
     * also writes stays as it is; that patch inherits the value to restore,
     * so if it fails too the field returns to the last value before both.
     */
    restore(current: T, patch: object, pending: unknown[]): T {
      const previous = replaced.get(patch);
      if (!previous) {
        return current;
      }
      const next = { ...current };
      const newer = pending.slice(pending.indexOf(patch) + 1);
      for (const field of Object.keys(patch)) {
        if (!isField(previous, field)) {
          continue;
        }
        const { heir, heirReplaced } = heirOf(newer, field);
        if (heirReplaced) {
          heirReplaced[field] = previous[field];
        } else if (!heir) {
          next[field] = previous[field];
        }
      }
      return next;
    },
  };
}
