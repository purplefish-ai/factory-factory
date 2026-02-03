export type ScrollMode = 'code' | 'markdown' | 'chat';

export interface ScrollState {
  top: number;
  left: number;
  stickToBottom?: boolean;
}

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface ScrollStoragePayload {
  v: 1;
  states: Record<string, ScrollState>;
}

const STORAGE_VERSION = 1;
const STORAGE_KEY_SCROLL_PREFIX = 'workspace-panel-scroll-';

export function makeScrollStorageKey(workspaceId: string): string {
  return `${STORAGE_KEY_SCROLL_PREFIX}${workspaceId}`;
}

export function makeScrollStateKey(tabId: string, mode: ScrollMode): string {
  return `${tabId}:${mode}`;
}

function isValidScrollState(state: unknown): state is ScrollState {
  if (typeof state !== 'object' || state === null) {
    return false;
  }
  const candidate = state as Record<string, unknown>;
  if ('stickToBottom' in candidate && typeof candidate.stickToBottom !== 'boolean') {
    return false;
  }
  return (
    typeof candidate.top === 'number' &&
    Number.isFinite(candidate.top) &&
    typeof candidate.left === 'number' &&
    Number.isFinite(candidate.left) &&
    candidate.top >= 0 &&
    candidate.left >= 0
  );
}

function sanitizeScrollState(state: ScrollState): ScrollState {
  return {
    top: Math.max(0, Number.isFinite(state.top) ? state.top : 0),
    left: Math.max(0, Number.isFinite(state.left) ? state.left : 0),
    stickToBottom: state.stickToBottom === true ? true : undefined,
  };
}

export function loadScrollStateRecord(
  storage: StorageLike,
  workspaceId: string
): Record<string, ScrollState> {
  try {
    const raw = storage.getItem(makeScrollStorageKey(workspaceId));
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ScrollStoragePayload).v !== STORAGE_VERSION ||
      typeof (parsed as ScrollStoragePayload).states !== 'object' ||
      (parsed as ScrollStoragePayload).states === null
    ) {
      return {};
    }
    const states = (parsed as ScrollStoragePayload).states;
    const cleaned: Record<string, ScrollState> = {};
    for (const [key, value] of Object.entries(states)) {
      if (isValidScrollState(value)) {
        cleaned[key] = sanitizeScrollState(value);
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

export function saveScrollStateRecord(
  storage: StorageLike,
  workspaceId: string,
  record: Record<string, ScrollState>
): void {
  const payload: ScrollStoragePayload = {
    v: STORAGE_VERSION,
    states: record,
  };
  storage.setItem(makeScrollStorageKey(workspaceId), JSON.stringify(payload));
}

export function getScrollStateFromRecord(
  record: Record<string, ScrollState>,
  tabId: string,
  mode: ScrollMode
): ScrollState | null {
  return record[makeScrollStateKey(tabId, mode)] ?? null;
}

export function upsertScrollState(
  record: Record<string, ScrollState>,
  tabId: string,
  mode: ScrollMode,
  state: ScrollState
): Record<string, ScrollState> {
  return {
    ...record,
    [makeScrollStateKey(tabId, mode)]: sanitizeScrollState(state),
  };
}

export function removeScrollStatesForTab(
  record: Record<string, ScrollState>,
  tabId: string
): Record<string, ScrollState> {
  const prefix = `${tabId}:`;
  const next: Record<string, ScrollState> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) {
      next[key] = value;
    }
  }
  return next;
}
