import { ApplicationError } from '@/backend/lib/application-error';

/** One synchronous admission boundary shared by runtime starts, queues and update readiness. */
export class ApplicationUpdateAdmission {
  private closed = false;
  private activeOperations = 0;

  isClosed(): boolean {
    return this.closed;
  }

  assertOpen(): void {
    if (this.closed) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'An application update is preparing. Try again after reconnecting.'
      );
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
    }
  }

  /** No await between inspecting work and closing admission. */
  tryClose(hasWork: () => boolean): boolean {
    if (this.closed) {
      return true;
    }
    if (this.activeOperations > 0 || hasWork()) {
      return false;
    }
    this.closed = true;
    return true;
  }

  release(): void {
    this.closed = false;
  }
}

export const applicationUpdateAdmission = new ApplicationUpdateAdmission();
