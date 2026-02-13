import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

interface PendingPermission {
  resolve: (response: RequestPermissionResponse) => void;
  params: RequestPermissionRequest;
}

/**
 * Promise-based bridge for ACP permission requests.
 *
 * When `AcpClientHandler.requestPermission()` is called by the ACP SDK, it creates a
 * Promise via `waitForUserResponse` that suspends until the user responds via WebSocket.
 * The frontend sends the user's choice back through `resolvePermission`, which resolves
 * the suspended Promise with the selected optionId.
 *
 * Lifecycle:
 *   1. ACP SDK calls requestPermission -> handler calls waitForUserResponse -> Promise created
 *   2. Frontend receives permission_request event -> user picks an option
 *   3. WebSocket handler calls resolvePermission -> Promise resolves -> SDK receives response
 *   4. On session cancel/stop -> cancelAll resolves all pending with cancelled outcome
 */
export class AcpPermissionBridge {
  private readonly pending = new Map<string, PendingPermission>();

  /**
   * Called by AcpClientHandler.requestPermission().
   * Creates a Promise that suspends until the user responds.
   */
  waitForUserResponse(
    requestId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(requestId, { resolve, params });
    });
  }

  /**
   * Called by permission-response.handler.ts when user selects an option.
   * Resolves the suspended Promise with the selected optionId.
   * Returns false if no pending request found for this requestId.
   */
  resolvePermission(requestId: string, optionId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }

    entry.resolve({
      outcome: {
        outcome: 'selected',
        optionId,
      },
    });
    this.pending.delete(requestId);
    return true;
  }

  /**
   * Called when session is cancelled/stopped.
   * Resolves all pending Promises with cancelled outcome.
   */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      entry.resolve({
        outcome: {
          outcome: 'cancelled',
        },
      });
    }
    this.pending.clear();
  }

  /**
   * Check if there is a pending permission request.
   */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Get the params for a pending request (for re-emit on session restore).
   */
  getPendingParams(requestId: string): RequestPermissionRequest | undefined {
    return this.pending.get(requestId)?.params;
  }

  /**
   * Get count of pending requests (for diagnostics).
   */
  get pendingCount(): number {
    return this.pending.size;
  }
}
