export function createTerminalRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `terminal-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function claimPendingTerminalTab(
  pendingTabs: Map<string, string>,
  requestId?: string
): string | null {
  if (requestId) {
    const tabId = pendingTabs.get(requestId);
    if (!tabId) {
      return null;
    }

    pendingTabs.delete(requestId);
    return tabId;
  }

  const nextPendingTab = pendingTabs.entries().next();
  if (nextPendingTab.done) {
    return null;
  }

  const [fallbackRequestId, fallbackTabId] = nextPendingTab.value;
  pendingTabs.delete(fallbackRequestId);
  return fallbackTabId;
}

export function removePendingTerminalTab(pendingTabs: Map<string, string>, tabId: string): void {
  for (const [requestId, pendingTabId] of pendingTabs) {
    if (pendingTabId === tabId) {
      pendingTabs.delete(requestId);
    }
  }
}
