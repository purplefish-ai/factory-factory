import { useEffect, useRef, useState } from 'react';

/** Browsing caches stay visible, but each live connection/runtime must refresh control authority. */
export function useFreshSubagentControls({
  sessionId,
  controlSessionId,
  controlRuntimeId,
  refetch,
  dataUpdatedAt = 0,
  isFetching = false,
  error,
}: {
  sessionId: string | null;
  controlSessionId?: string;
  controlRuntimeId?: string;
  dataUpdatedAt?: number;
  isFetching?: boolean;
  error?: unknown;
  refetch: (options?: {
    cancelRefetch?: boolean;
    throwOnError?: boolean;
  }) => Promise<{ isError: boolean; data: unknown; dataUpdatedAt: number; isFetching?: boolean }>;
}): string | undefined {
  const scopeKey =
    controlSessionId && controlSessionId === sessionId && controlRuntimeId
      ? JSON.stringify([sessionId, controlRuntimeId])
      : null;
  const scopeRef = useRef<{
    key: string;
    baselineUpdatedAt: number;
    hadFetch: boolean;
    freshReadAfter?: number;
  } | null>(null);
  if (scopeRef.current?.key !== scopeKey) {
    scopeRef.current = scopeKey
      ? { key: scopeKey, baselineUpdatedAt: dataUpdatedAt, hadFetch: isFetching }
      : null;
  }
  const scope = scopeRef.current;
  const [confirmedScope, setConfirmedScope] = useState<object | null>(null);
  useEffect(() => {
    if (!scope) {
      return;
    }
    let current = true;
    const refresh = async () => {
      let floor = scope.baselineUpdatedAt;
      if (scope.hadFetch) {
        // An unseeded query can reuse its pre-scope in-flight promise. Drain it first.
        const previous = await refetch({ cancelRefetch: false, throwOnError: true }).catch(
          () => undefined
        );
        if (!current) {
          return;
        }
        floor = Math.max(floor, previous?.dataUpdatedAt ?? 0);
      }
      scope.freshReadAfter = floor;
      const result = await refetch({ cancelRefetch: true, throwOnError: true });
      // Cancellation can resolve cached success even with throwOnError. A newer
      // timestamp proves a completed read after all pre-scope work was drained.
      if (
        current &&
        !result.isError &&
        !result.isFetching &&
        result.data &&
        result.dataUpdatedAt > floor
      ) {
        setConfirmedScope(scope);
      }
    };
    void refresh().catch(() => {
      /* Failed or superseded refresh never grants cached control. */
    });
    return () => {
      current = false;
    };
  }, [scope, refetch]);
  return !error &&
    scope &&
    (scope === confirmedScope ||
      (!isFetching && scope.freshReadAfter !== undefined && dataUpdatedAt > scope.freshReadAfter))
    ? controlSessionId
    : undefined;
}
