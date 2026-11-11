class SupersededConfigCommit extends Error {}

export type AcceptedConfigCommit = {
  assertCurrent: () => void;
  isCurrent: () => boolean;
  persist: (operation: (assertCurrent: () => void) => Promise<void>) => Promise<boolean>;
};

/** Accepted state, rather than queued intent, fences every retry and publication. */
export class SessionConfigCommitAuthority {
  private readonly accepted = new Map<string, object>();
  // Startup callbacks and inactive writes may re-enter the public persistence API.
  // Reuse their accepted guard so re-entry cannot revive an obsolete snapshot.
  private readonly guards = new WeakMap<() => void, AcceptedConfigCommit>();

  /** Durable deletion invalidates retained guards without retaining the session ID. */
  release(sessionId: string): void {
    this.accepted.delete(sessionId);
  }

  accept(sessionId: string, assertRuntime: () => void): AcceptedConfigCommit {
    const existing = this.guards.get(assertRuntime);
    if (existing) {
      return existing;
    }
    assertRuntime();
    const token = {};
    this.accepted.set(sessionId, token);
    const assertCurrent = () => {
      assertRuntime();
      if (this.accepted.get(sessionId) !== token) {
        throw new SupersededConfigCommit();
      }
    };
    const commit: AcceptedConfigCommit = {
      assertCurrent,
      isCurrent: () => {
        try {
          assertCurrent();
          return true;
        } catch (error) {
          if (error instanceof SupersededConfigCommit) {
            return false;
          }
          throw error;
        }
      },
      persist: async (operation) => {
        try {
          assertCurrent();
          await operation(assertCurrent);
          assertCurrent();
          return true;
        } catch (error) {
          // Runtime/source failure remains owned by its caller even when a
          // newer token also exists. Only same-source supersession is a no-op.
          if (!commit.isCurrent()) {
            return false;
          }
          throw error;
        }
      },
    };
    this.guards.set(assertCurrent, commit);
    return commit;
  }
}
