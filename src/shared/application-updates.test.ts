import { describe, expect, it } from 'vitest';
import {
  applicationUpdateStatusSchema,
  updateSupervisorMessageSchema,
} from './application-updates';

describe('application update status boundary', () => {
  it.each(['waiting', 'preparing', 'restarting'])('requires a target version while %s', (phase) => {
    for (const status of [
      { phase },
      { phase, targetVersion: undefined },
      { phase, targetVersion: 'invalid' },
    ]) {
      expect(applicationUpdateStatusSchema.safeParse(status).success).toBe(false);
      expect(
        updateSupervisorMessageSchema.safeParse({ type: 'update-status', status }).success
      ).toBe(false);
    }
    expect(applicationUpdateStatusSchema.safeParse({ phase, targetVersion: '1.2.3' }).success).toBe(
      true
    );
  });
  it.each(['idle', 'failed'])('allows a missing target while %s', (phase) => {
    expect(applicationUpdateStatusSchema.safeParse({ phase }).success).toBe(true);
  });
});
