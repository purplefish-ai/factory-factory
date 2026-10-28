import type { Workspace } from '@prisma-gen/client';

export type AcceptedWorkspaceBranch = Pick<Workspace, 'id' | 'branchName' | 'updatedAt' | 'status'>;

/** Serializes committed branch facts through synchronous application delivery. */
export class AcceptedBranchPublisher {
  private readonly pending = new Map<string, Promise<AcceptedWorkspaceBranch>>();
  private readonly listeners = new Set<(row: AcceptedWorkspaceBranch) => void>();

  subscribe(listener: (row: AcceptedWorkspaceBranch) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  accept(workspaceId: string, persist: () => Promise<AcceptedWorkspaceBranch>) {
    const previous = this.pending.get(workspaceId);
    const accepted = (
      previous !== undefined ? previous.catch(() => undefined) : Promise.resolve()
    ).then(async () => {
      const row = await persist();
      for (const listener of this.listeners) {
        listener(row);
      }
      return row;
    });
    this.pending.set(workspaceId, accepted);
    const release = () => {
      if (this.pending.get(workspaceId) === accepted) {
        this.pending.delete(workspaceId);
      }
    };
    void accepted.then(release, release);
    return accepted;
  }
}
