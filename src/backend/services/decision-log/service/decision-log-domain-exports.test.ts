import { describe, expect, it } from 'vitest';
import { decisionLogService } from '@/backend/services/decision-log';

describe('decision log domain exports', () => {
  it('exports the capsule-owned decision log service', () => {
    expect(decisionLogService).toBeDefined();
  });
});
