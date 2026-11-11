import { z } from 'zod';
import { usePersistedState } from '@/client/hooks/use-persisted-state';

const PlanViewModeSchema = z.enum(['rendered', 'raw']);
export type PlanViewMode = z.infer<typeof PlanViewModeSchema>;

const PLAN_VIEW_STORAGE_KEY = 'ff:plan-view-mode';

export function usePlanViewMode() {
  return usePersistedState(PLAN_VIEW_STORAGE_KEY, PlanViewModeSchema, 'rendered', {
    format: 'text',
  });
}
