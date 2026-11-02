import { expect, it } from 'vitest';
import { agentRunHistorySchema } from './agent-history';

it('requires explicit, valid context availability in run history', () => {
  const context = agentRunHistorySchema.shape.context;
  expect(context.safeParse(undefined).success).toBe(false);
  expect(context.safeParse({ state: 'RETAINED' }).success).toBe(true);
  expect(context.safeParse({ state: 'EXPIRED' }).success).toBe(false);
});
