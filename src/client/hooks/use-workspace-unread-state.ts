import { useEffect, useRef, useState } from 'react';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';

function collectNewUnread(
  workspaces: ServerWorkspace[],
  currentWorkspaceId: string | undefined,
  prevActivityRef: React.MutableRefObject<Map<string, string | null>>
): string[] {
  const toAdd: string[] = [];
  for (const ws of workspaces) {
    const prev = prevActivityRef.current.get(ws.id);
    const curr = ws.lastActivityAt ?? null;
    if (prev === undefined) {
      prevActivityRef.current.set(ws.id, curr);
    } else {
      if (curr !== prev && ws.id !== currentWorkspaceId) {
        toAdd.push(ws.id);
      }
      prevActivityRef.current.set(ws.id, curr);
    }
  }
  return toAdd;
}

/**
 * Tracks which workspaces have received new activity since the user last viewed them.
 * Uses lastActivityAt to detect changes; clears on workspace navigation.
 */
export function useWorkspaceUnreadState(
  workspaces: ServerWorkspace[] | undefined,
  currentWorkspaceId: string | undefined
): Set<string> {
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const prevActivityRef = useRef<Map<string, string | null>>(new Map());
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!workspaces) {
      return;
    }

    if (!initializedRef.current) {
      for (const ws of workspaces) {
        prevActivityRef.current.set(ws.id, ws.lastActivityAt ?? null);
      }
      initializedRef.current = true;
      return;
    }

    const toAdd = collectNewUnread(workspaces, currentWorkspaceId, prevActivityRef);
    if (toAdd.length > 0) {
      setUnreadIds((prev) => {
        const next = new Set(prev);
        for (const id of toAdd) {
          next.add(id);
        }
        return next;
      });
    }
  }, [workspaces, currentWorkspaceId]);

  // Clear when navigating to a workspace
  useEffect(() => {
    if (!currentWorkspaceId) {
      return;
    }
    setUnreadIds((prev) => {
      if (!prev.has(currentWorkspaceId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(currentWorkspaceId);
      return next;
    });
  }, [currentWorkspaceId]);

  return unreadIds;
}
