import { useEffect, useRef, useState } from 'react';

/** Browsing caches stay visible, but each live connection/runtime must refresh control authority. */
export function useFreshSubagentControls({
  sessionId,
  controlSessionId,
  controlRuntimeId,
  refetch,
  dataUpdatedAt = 0,
  error,
}: {
  sessionId: string | null;
  controlSessionId?: string;
  controlRuntimeId?: string;
  dataUpdatedAt?: number;
  error?: unknown;
  refetch: () => Promise<{ isError: boolean; data: unknown }>;
}): string | undefined {
  const scopeKey =
    controlSessionId && controlSessionId === sessionId && controlRuntimeId
      ? JSON.stringify([sessionId, controlRuntimeId])
      : null;
  const scopeRef = useRef<{ key: string; baselineUpdatedAt: number } | null>(null);
  if (scopeRef.current?.key !== scopeKey) {
    scopeRef.current = scopeKey ? { key: scopeKey, baselineUpdatedAt: dataUpdatedAt } : null;
  }
  const scope = scopeRef.current;
  const [confirmedScope, setConfirmedScope] = useState<object | null>(null);
  useEffect(() => {
    if (!scope) {
      return;
    }
    let current = true;
    void refetch().then(
      (result) => {
        if (current && !result.isError && result.data) {
          setConfirmedScope(scope);
        }
      },
      () => {
        /* Failed refresh never grants control over cached rows. */
      }
    );
    return () => {
      current = false;
    };
  }, [scope, refetch]);
  return !error && scope && (scope === confirmedScope || dataUpdatedAt > scope.baselineUpdatedAt)
    ? controlSessionId
    : undefined;
}
