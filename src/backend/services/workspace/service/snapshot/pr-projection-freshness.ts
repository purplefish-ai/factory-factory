import type { SnapshotFieldGroup, SnapshotUpdateInput } from '@/shared/workspace-projection-fields';
import { snapshotFieldGroups } from '@/shared/workspace-projection-fields';

/** Persisted association revisions order facts independently of async publication clocks. */
export class PrProjectionFreshness {
  private readonly revisions = new Map<string, Map<string, number>>();

  prepare(workspaceId: string, input: SnapshotUpdateInput) {
    const known = this.revisions.get(workspaceId);
    const stale =
      known &&
      (!input.prs ||
        input.prs.some((pr) => {
          const previous = known.get(pr.id);
          return previous !== undefined && (pr.revision === undefined || pr.revision < previous);
        }));
    if (stale) {
      const update = { ...input, ratchetState: undefined };
      for (const field of snapshotFieldGroups.flatMap(({ group, fields }) =>
        group === 'pr' ? fields : []
      )) {
        delete update[field];
      }
      return { update, newer: false };
    }
    const newer =
      input.prs?.some(
        (pr) => pr.revision !== undefined && pr.revision > (known?.get(pr.id) ?? -1)
      ) ?? false;
    return { update: input, newer };
  }

  accept(workspaceId: string, input: SnapshotUpdateInput, group: SnapshotFieldGroup): void {
    if (group !== 'pr' || !input.prs) {
      return;
    }
    for (const pr of input.prs) {
      if (pr.revision === undefined) {
        continue;
      }
      let known = this.revisions.get(workspaceId);
      if (!known) {
        known = new Map();
        this.revisions.set(workspaceId, known);
      }
      known.set(pr.id, pr.revision);
    }
  }

  remove(workspaceId: string): void {
    this.revisions.delete(workspaceId);
  }

  clear(): void {
    this.revisions.clear();
  }
}
