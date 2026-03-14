import { describe, expect, it } from 'vitest';
import { githubCLIService, prSnapshotService } from './index';

/**
 * Domain barrel export smoke test.
 *
 * Verifies that every public runtime export from the GitHub domain barrel
 * is a real value (not `undefined` due to circular dependency breakage).
 * Static imports ensure the barrel can be loaded at module resolution time.
 */
describe('GitHub domain exports', () => {
  it('exports githubCLIService as an object', () => {
    expect(githubCLIService).toBeDefined();
  });

  it('exports prSnapshotService as an object', () => {
    expect(prSnapshotService).toBeDefined();
  });
});
