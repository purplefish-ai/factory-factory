import { useCallback, useEffect, useState } from 'react';

/**
 * Duration to show the red glow attention indicator (30 seconds)
 */
const ATTENTION_DURATION_MS = 30_000;

/**
 * Tracks which workspaces need user attention (for red glow animation).
 * This is event-driven and synchronized with the notification sound.
 */
export function useWorkspaceAttention() {
  const [attentionWorkspaces, setAttentionWorkspaces] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const handleAttentionRequest = (event: CustomEvent<{ workspaceId: string }>) => {
      const { workspaceId } = event.detail;
      const timestamp = Date.now();

      setAttentionWorkspaces((prev) => {
        const next = new Map(prev);
        next.set(workspaceId, timestamp);
        return next;
      });
    };

    window.addEventListener(
      'workspace-attention-required',
      handleAttentionRequest as EventListener
    );

    return () => {
      window.removeEventListener(
        'workspace-attention-required',
        handleAttentionRequest as EventListener
      );
    };
  }, []);

  // Clean up expired attention markers every second
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setAttentionWorkspaces((prev) => {
        const next = new Map(prev);
        let changed = false;

        for (const [workspaceId, timestamp] of next.entries()) {
          if (now - timestamp > ATTENTION_DURATION_MS) {
            next.delete(workspaceId);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const needsAttention = useCallback(
    (workspaceId: string): boolean => {
      const timestamp = attentionWorkspaces.get(workspaceId);
      if (!timestamp) {
        return false;
      }

      const elapsed = Date.now() - timestamp;
      return elapsed < ATTENTION_DURATION_MS;
    },
    [attentionWorkspaces]
  );

  const clearAttention = useCallback((workspaceId: string) => {
    setAttentionWorkspaces((prev) => {
      if (!prev.has(workspaceId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(workspaceId);
      return next;
    });
  }, []);

  return { needsAttention, clearAttention };
}
