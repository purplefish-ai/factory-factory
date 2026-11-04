import type { SnapshotFieldGroup, SnapshotUpdateInput } from '@/shared/workspace-projection-fields';
import { snapshotFieldGroups } from '@/shared/workspace-projection-fields';

/** Persisted association revisions order facts independently of async publication clocks. */
export class PrProjectionFreshness {
  private readonly revisions = new Map<string, Map<string, number>>();
  private readonly collectionRevisions = new Map<string, number>();

  private isStale(workspaceId: string, input: SnapshotUpdateInput): boolean {
    const collectionRevision = this.collectionRevisions.get(workspaceId);
    if (
      collectionRevision !== undefined &&
      (input.prCollectionRevision === undefined || input.prCollectionRevision < collectionRevision)
    ) {
      return true;
    }
    const known = this.revisions.get(workspaceId);
    return (
      known !== undefined &&
      (!input.prs ||
        input.prs.some((pr) => {
          const previous = known.get(pr.id);
          return previous !== undefined && (pr.revision === undefined || pr.revision < previous);
        }))
    );
  }

  prepare(workspaceId: string, input: SnapshotUpdateInput) {
    const known = this.revisions.get(workspaceId);
    if (this.isStale(workspaceId, input)) {
      const update = {
        ...input,
        ratchetState: undefined,
        ...(input.prs ? { ratchetEnabled: undefined, prMonitoring: undefined } : {}),
      };
      for (const field of snapshotFieldGroups.flatMap(({ group, fields }) =>
        group === 'pr' ? fields : []
      )) {
        delete update[field];
      }
      return { update, newer: false, preserveRatchetTimestamp: false };
    }
    const newerCollection =
      input.prCollectionRevision !== undefined &&
      input.prCollectionRevision > (this.collectionRevisions.get(workspaceId) ?? -1);
    const newer =
      newerCollection ||
      (input.prs?.some(
        (pr) => pr.revision !== undefined && pr.revision > (known?.get(pr.id) ?? -1)
      ) ??
        false);
    // PR fact revisions cannot authorize replacing independently edited monitoring settings.
    const preserveRatchetTimestamp =
      newer && (known !== undefined || this.collectionRevisions.has(workspaceId));
    const update = preserveRatchetTimestamp
      ? { ...input, ratchetEnabled: undefined, prMonitoring: undefined }
      : input;
    return { update, newer, preserveRatchetTimestamp };
  }

  accept(workspaceId: string, input: SnapshotUpdateInput, group: SnapshotFieldGroup): void {
    if (group !== 'pr') {
      return;
    }
    if (input.prCollectionRevision !== undefined) {
      this.collectionRevisions.set(workspaceId, input.prCollectionRevision);
    }
    if (!input.prs) {
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
    this.collectionRevisions.delete(workspaceId);
  }

  clear(): void {
    this.revisions.clear();
    this.collectionRevisions.clear();
  }
}
