import { useCallback, useRef, useState } from 'react';
import { useLocation } from 'react-router';

type RouteCategory = 'workspace_detail' | 'board' | 'default';

const ROUTE_CATEGORIES: RouteCategory[] = ['workspace_detail', 'board', 'default'];

const ROUTE_DEFAULTS: Record<RouteCategory, boolean> = {
  workspace_detail: true,
  board: false,
  default: true,
};

const STORAGE_KEYS: Record<RouteCategory, string> = {
  workspace_detail: 'sidebar_state_workspace_detail',
  board: 'sidebar_state_board',
  default: 'sidebar_state_default',
};

function getRouteCategory(pathname: string): RouteCategory {
  // /projects/:slug/workspaces/:id — workspace detail
  if (/^\/projects\/[^/]+\/workspaces\/[^/]+/.test(pathname)) {
    return 'workspace_detail';
  }
  // /projects/:slug/workspaces — board view
  if (/^\/projects\/[^/]+\/workspaces\/?$/.test(pathname)) {
    return 'board';
  }
  return 'default';
}

export function getRouteCategoryForPath(pathname: string): RouteCategory {
  return getRouteCategory(pathname);
}

function getPersistedState(category: RouteCategory): boolean | null {
  try {
    const value = localStorage.getItem(STORAGE_KEYS[category]);
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

// Categories where user overrides should NOT persist across navigations.
// The board view should always start collapsed — the sidebar opens only
// transiently (e.g. to click a link) and resets on next visit.
const TRANSIENT_CATEGORIES: Set<RouteCategory> = new Set(['board']);

export function clearTransientOverrideOnCategoryChange(
  overrides: Partial<Record<RouteCategory, boolean>>,
  previousCategory: RouteCategory,
  nextCategory: RouteCategory
): Partial<Record<RouteCategory, boolean>> {
  if (previousCategory === nextCategory || !TRANSIENT_CATEGORIES.has(previousCategory)) {
    return overrides;
  }

  if (!(previousCategory in overrides)) {
    return overrides;
  }

  const nextOverrides = { ...overrides };
  delete nextOverrides[previousCategory];
  return nextOverrides;
}

function persistState(category: RouteCategory, open: boolean) {
  if (TRANSIENT_CATEGORIES.has(category)) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEYS[category], String(open));
  } catch {
    // Ignore storage errors
  }
}

function loadAllPersistedStates(): Partial<Record<RouteCategory, boolean>> {
  const result: Partial<Record<RouteCategory, boolean>> = {};
  for (const cat of ROUTE_CATEGORIES) {
    if (TRANSIENT_CATEGORIES.has(cat)) {
      continue;
    }
    const persisted = getPersistedState(cat);
    if (persisted !== null) {
      result[cat] = persisted;
    }
  }
  return result;
}

/**
 * Manages sidebar open/closed state with per-route-category persistence.
 *
 * The open state is derived synchronously from the current route category,
 * so there's no flash when navigating between routes with different defaults.
 *
 * User overrides (toggling) are persisted per category to localStorage.
 *
 * Returns `[open, setOpen]` for use with SidebarProvider's controlled mode.
 */
export function useRouteSidebarState(): [boolean, (open: boolean) => void] {
  const { pathname } = useLocation();
  const category = getRouteCategory(pathname);
  const previousCategoryRef = useRef<RouteCategory>(category);
  const transientOverridesRef = useRef<Partial<Record<RouteCategory, boolean>>>({});
  const [, forceRender] = useState(0);

  // Store user overrides per category (initialized from localStorage)
  const [overrides, setOverrides] =
    useState<Partial<Record<RouteCategory, boolean>>>(loadAllPersistedStates);

  // Clear transient overrides as soon as we leave their route category.
  transientOverridesRef.current = clearTransientOverrideOnCategoryChange(
    transientOverridesRef.current,
    previousCategoryRef.current,
    category
  );
  previousCategoryRef.current = category;

  // Derive open state synchronously — no useEffect, no flash
  const open =
    transientOverridesRef.current[category] ?? overrides[category] ?? ROUTE_DEFAULTS[category];

  const setOpen = useCallback(
    (value: boolean) => {
      if (TRANSIENT_CATEGORIES.has(category)) {
        transientOverridesRef.current = { ...transientOverridesRef.current, [category]: value };
        forceRender((count) => count + 1);
        return;
      }
      setOverrides((prev) => ({ ...prev, [category]: value }));
      persistState(category, value);
    },
    [category]
  );

  return [open, setOpen];
}
