const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width';

const SIDEBAR_DEFAULT_WIDTH = 352;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 640;

type SidebarWidthStorageReader = Pick<Storage, 'getItem'>;
type SidebarWidthStorageWriter = Pick<Storage, 'setItem'>;

function getLocalStorageSafe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseSidebarWidth(value: string | null): number {
  if (value == null) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  const parsed = Number.parseFloat(value);
  return clampSidebarWidth(parsed);
}

export function getPersistedSidebarWidth(storage: SidebarWidthStorageReader | null = null): number {
  const activeStorage = storage ?? getLocalStorageSafe();
  if (!activeStorage) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  try {
    return parseSidebarWidth(activeStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function persistSidebarWidth(
  width: number,
  storage: SidebarWidthStorageWriter | null = null
): void {
  const activeStorage = storage ?? getLocalStorageSafe();
  if (!activeStorage) {
    return;
  }
  try {
    activeStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Ignore storage access issues.
  }
}
