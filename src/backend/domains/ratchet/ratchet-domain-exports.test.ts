import { describe, expect, it } from 'vitest';
import {
  // CI fixer
  ciFixerService,
  // CI monitor
  ciMonitorService,
  // Fixer session
  fixerSessionService,
  // Core ratchet
  ratchetService,
  // Reconciliation
  reconciliationService,
} from './index';

describe('Ratchet domain exports', () => {
  it('exports ratchetService as an object', () => {
    expect(ratchetService).toBeDefined();
  });

  it('exports ciFixerService as an object', () => {
    expect(ciFixerService).toBeDefined();
  });

  it('exports ciMonitorService as an object', () => {
    expect(ciMonitorService).toBeDefined();
  });

  it('exports fixerSessionService as an object', () => {
    expect(fixerSessionService).toBeDefined();
  });

  it('exports reconciliationService as an object', () => {
    expect(reconciliationService).toBeDefined();
  });
});
