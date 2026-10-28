/** A cancelled request may leave a shared candidate's real completion work alive. */
export class SessionStartupRequest {
  private cancellation?: { error: unknown };

  constructor(
    private readonly assertRuntime: () => void,
    private readonly isShared: () => boolean,
    private readonly assertRequest?: () => Promise<void>
  ) {}

  async check(): Promise<void> {
    this.assertRuntime();
    try {
      await this.assertRequest?.();
    } catch (error) {
      this.assertRuntime();
      this.cancellation = { error };
      if (!this.isShared()) {
        throw error;
      }
    }
    this.assertRuntime();
  }

  rejectCancelledRequest(): void {
    if (this.cancellation) {
      throw this.cancellation.error;
    }
  }

  isRequestFailure(error: unknown): boolean {
    return Boolean(this.cancellation && error === this.cancellation.error);
  }

  preservesSharedCandidate(error: unknown): boolean {
    if (!this.cancellation || error !== this.cancellation.error) {
      return false;
    }
    try {
      this.assertRuntime();
      return this.isShared();
    } catch {
      return false;
    }
  }
}
