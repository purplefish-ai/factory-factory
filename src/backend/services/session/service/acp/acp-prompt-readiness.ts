export type AcpConfigurationLease = { complete(): void; fail(error: unknown): void };

/**
 * A handle-local barrier; one failed setup permanently rejects that incarnation.
 * Deliberately has no independent deadline: stalled setup keeps work blocked
 * until setup fails, the child exits, or the session is stopped. Elapsed time
 * cannot establish that native permissions have been applied.
 */
export class AcpPromptReadiness {
  private barrier?: { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  private readonly pending = new Set<symbol>();
  private failed = false;

  wait(): Promise<void> | undefined {
    return this.barrier?.promise;
  }

  begin(): AcpConfigurationLease {
    if (!this.barrier) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => undefined);
      this.barrier = { promise, resolve, reject };
    }
    const barrier = this.barrier;
    const token = Symbol('configuration');
    this.pending.add(token);
    return {
      complete: () => {
        if (!this.pending.delete(token) || this.failed || this.pending.size > 0) {
          return;
        }
        if (this.barrier === barrier) {
          this.barrier = undefined;
          barrier.resolve();
        }
      },
      fail: (error) => {
        if (this.barrier === barrier && this.pending.has(token)) {
          this.fail(error);
        }
      },
    };
  }

  fail(error: unknown): void {
    if (!this.barrier) {
      this.begin();
    }
    this.failed = true;
    this.pending.clear();
    this.barrier?.reject(error);
  }
}
