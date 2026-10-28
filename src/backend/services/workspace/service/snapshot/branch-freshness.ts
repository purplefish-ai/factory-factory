import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

/** Private DB branch provenance, independent of all snapshot group clocks. */
export class BranchFreshness {
  private readonly timestamps = new Map<string, number>();

  canAccept(workspaceId: string, timestamp: number, acceptedWrite = false): boolean {
    const previous = this.timestamps.get(workspaceId);
    return (
      Number.isFinite(timestamp) &&
      (previous === undefined || timestamp > previous || (acceptedWrite && timestamp === previous))
    );
  }

  merge(
    entry: WorkspaceSnapshotEntry,
    branchName: string | null | undefined,
    timestamp: number,
    acceptedWrite = false
  ) {
    if (branchName === undefined || !this.canAccept(entry.workspaceId, timestamp, acceptedWrite)) {
      return { accepted: false, rawChanged: false };
    }
    this.timestamps.set(entry.workspaceId, timestamp);
    const rawChanged = entry.branchName !== branchName;
    entry.branchName = branchName;
    return { accepted: true, rawChanged };
  }

  remove(workspaceId: string): void {
    this.timestamps.delete(workspaceId);
  }
  clear(): void {
    this.timestamps.clear();
  }
}
