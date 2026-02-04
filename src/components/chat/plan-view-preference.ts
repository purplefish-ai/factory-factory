import { useEffect, useState } from 'react';

export type PlanViewMode = 'rendered' | 'raw';

const PLAN_VIEW_STORAGE_KEY = 'ff:plan-view-mode';
const DEFAULT_PLAN_VIEW_MODE: PlanViewMode = 'rendered';

function isPlanViewMode(value: unknown): value is PlanViewMode {
  return value === 'rendered' || value === 'raw';
}

export function loadPlanViewMode(): PlanViewMode {
  if (typeof window === 'undefined') {
    return DEFAULT_PLAN_VIEW_MODE;
  }
  try {
    const stored = window.localStorage.getItem(PLAN_VIEW_STORAGE_KEY);
    if (stored && isPlanViewMode(stored)) {
      return stored;
    }
  } catch {
    return DEFAULT_PLAN_VIEW_MODE;
  }
  return DEFAULT_PLAN_VIEW_MODE;
}

export function persistPlanViewMode(mode: PlanViewMode): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(PLAN_VIEW_STORAGE_KEY, mode);
  } catch {
    // Silently ignore storage errors
  }
}

export function usePlanViewMode(): [PlanViewMode, (mode: PlanViewMode) => void] {
  const [mode, setMode] = useState<PlanViewMode>(() => loadPlanViewMode());

  useEffect(() => {
    persistPlanViewMode(mode);
  }, [mode]);

  return [mode, setMode];
}
