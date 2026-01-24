/**
 * Shared utilities for reconciliation failure tracking
 */

interface ReconcileFailure {
  timestamp: string;
  error: string;
  action: string;
}

/**
 * Add a failure to the reconcile failures array, keeping only the last 10
 */
export function appendReconcileFailure(
  existingFailures: unknown[] | null | undefined,
  error: string,
  action: string
): object[] {
  const failures = (existingFailures ?? []) as ReconcileFailure[];
  const newFailure: ReconcileFailure = {
    timestamp: new Date().toISOString(),
    error,
    action,
  };

  // Keep last 10 failures
  return [...failures, newFailure].slice(-10) as object[];
}
