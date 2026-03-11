import { describe, expect, it } from 'vitest';
import { terminalService } from './index';

/**
 * Domain barrel export smoke test.
 *
 * Verifies that every public runtime export from the Terminal domain barrel
 * is a real value (not `undefined` due to circular dependency breakage).
 * Static imports ensure the barrel can be loaded at module resolution time.
 */
describe('Terminal domain exports', () => {
  it('exports terminalService as an object', () => {
    expect(terminalService).toBeDefined();
  });
});
