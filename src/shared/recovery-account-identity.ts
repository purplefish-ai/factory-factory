import { z } from 'zod';

/** Remap only the supported execution identity field, never provider conversation IDs. */
export function remapRecoveryExecution(input: unknown, ids: ReadonlyMap<string, string>) {
  const execution = z.record(z.string(), z.json()).parse(input);
  const accountId = execution.codexAccountId;
  if (accountId === undefined || accountId === null) {
    return execution;
  }
  const originalId = z.string().min(1).parse(accountId);
  const mapped = ids.get(originalId);
  if (!mapped) {
    throw new Error('Recovery execution is missing account identity metadata');
  }
  return { ...execution, codexAccountId: mapped };
}
