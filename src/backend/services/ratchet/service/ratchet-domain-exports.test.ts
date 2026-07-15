import { describe, expect, it } from 'vitest';
import {
  // Fixer session
  fixerSessionService,
  // Core ratchet
  ratchetService,
} from './index';

describe('Ratchet domain exports', () => {
  it('exports ratchetService as an object', () => {
    expect(ratchetService).toBeDefined();
  });

  it('exports fixerSessionService as an object', () => {
    expect(fixerSessionService).toBeDefined();
  });
});
