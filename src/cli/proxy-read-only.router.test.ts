import { expect, it } from 'vitest';
import { z } from 'zod';
import { appRouter } from '@/backend/trpc';
import { PUBLIC_BLOCKED_PROCEDURES } from './proxy-read-only';

const procedureDefSchema = z.object({ type: z.string() });

/** tRPC procedures are functions carrying a `_def` with their type. */
function getProcedureType(path: string): string | undefined {
  const procedure: unknown = Reflect.get(appRouter._def.procedures, path);
  if (typeof procedure !== 'function') {
    return undefined;
  }
  const def = procedureDefSchema.safeParse(Reflect.get(procedure, '_def'));
  return def.success ? def.data.type : undefined;
}

// A renamed procedure would silently fall off the public tunnel's block list.
it.each([...PUBLIC_BLOCKED_PROCEDURES])('%s is a query on the app router', (path) => {
  expect(getProcedureType(path)).toBe('query');
});

it('detects a missing procedure', () => {
  expect(getProcedureType('admin.notAProcedure')).toBeUndefined();
});
