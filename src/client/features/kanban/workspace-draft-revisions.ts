interface Revision {
  draft: { revision: string };
  order: number;
  pins: number;
  cleared: boolean;
}

/** Keep ordering only for the current edit and requests that still own a revision. */
export class WorkspaceDraftRevisions {
  readonly retained = new Map<string, Revision>();
  // Keep revision-based rejection for active requests and the latest lifecycle.
  // Older callbacks are excluded by the hook's generation guard; weak identity
  // tombstones also reject original draft objects without keeping them alive.
  private lastCleared: string | null = null;
  private current: string | null = null;
  private nextOrder = 0;
  private saved: { revision: string; order: number } | null = null;
  private readonly cleared = new WeakSet<object>();

  edit(draft: { revision: string }): number {
    const previous = this.current;
    this.current = draft.revision;
    const revision = this.retained.get(draft.revision) ?? {
      draft,
      order: ++this.nextOrder,
      pins: 0,
      cleared: false,
    };
    this.retained.set(draft.revision, revision);
    this.prune(previous);
    return revision.order;
  }

  persisted(revision: string, order: number) {
    this.saved = { revision, order };
  }

  pin(revision: string): () => void {
    const retained = this.retained.get(revision);
    if (!retained) {
      return () => undefined;
    }
    retained.pins++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retained.pins--;
      this.prune(revision);
    };
  }

  // Only our last committed disk revision can be an older fallback. Ordering
  // proves a later successful write cannot be deleted by an older request.
  canClear(expected: string, disk: string, order = this.retained.get(expected)?.order): boolean {
    return (
      disk === expected ||
      (order !== undefined && this.saved?.revision === disk && this.saved.order <= order)
    );
  }

  clear(revision: string): number | undefined {
    const retained = this.retained.get(revision);
    this.lastCleared = revision;
    if (retained) {
      retained.cleared = true;
      this.cleared.add(retained.draft);
    }
    if (this.current === revision) {
      this.current = null;
    }
    this.prune(revision);
    return retained?.order;
  }

  deleted(revision: string) {
    if (this.saved?.revision === revision) {
      this.saved = null;
    }
  }

  isCleared(draft: { revision: string }): boolean {
    return (
      this.cleared.has(draft) ||
      this.lastCleared === draft.revision ||
      this.retained.get(draft.revision)?.cleared === true
    );
  }

  private prune(revision: string | null) {
    if (revision !== null && revision !== this.current && !this.retained.get(revision)?.pins) {
      this.retained.delete(revision);
    }
  }
}
