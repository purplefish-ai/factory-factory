import { z } from 'zod';
import { usePersistedState } from '@/client/hooks/use-persisted-state';

const STORAGE_KEY = 'kanban-waiting-sort-order';
const WaitingSortOrderSchema = z.enum(['latest-message', 'created']);

/** One browser preference shared across project boards and tabs. */
export function useWaitingSortOrder() {
  return usePersistedState(STORAGE_KEY, WaitingSortOrderSchema, 'latest-message', {
    format: 'text',
    crossTab: true,
  });
}
