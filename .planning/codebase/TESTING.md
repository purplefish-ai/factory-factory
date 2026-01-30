# Testing Patterns

**Analysis Date:** 2026-01-29

## Test Framework

**Runner:**
- Vitest v4.0.18
- Config: `vitest.config.ts` in project root
- Environment: Node.js (configured via `environment: 'node'`)
- Globals: Enabled (no need to import test functions)

**Assertion Library:**
- Vitest built-in matchers (expect)
- Supports full Jest-compatible assertion API

**Run Commands:**
```bash
pnpm test                 # Run all tests once
pnpm test:watch          # Watch mode for development
pnpm test:coverage       # Generate coverage report
```

## Test File Organization

**Location:**
- Co-located with source files
- Pattern: `{module}.test.ts` placed next to `{module}.ts`
- Examples:
  - `src/backend/services/scheduler.service.test.ts` → `src/backend/services/scheduler.service.ts`
  - `src/backend/claude/session.test.ts` → `src/backend/claude/session.ts`
  - `src/lib/queue-storage.test.ts` → `src/lib/queue-storage.ts`

**Naming:**
- All test files use `.test.ts` suffix (not `.spec.ts`)
- Test file names mirror source file names exactly

**Vitest config includes:**
```
include: ['src/**/*.test.ts'],
exclude: ['node_modules', 'dist', '.next'],
```

## Test Structure

**Suite Organization:**

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ServiceToTest } from './service';

describe('ServiceName', () => {
  let service: ServiceToTest;

  beforeEach(() => {
    // Setup before each test
    service = new ServiceToTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup after each test
    vi.restoreAllMocks();
  });

  describe('methodName', () => {
    it('should do something specific', () => {
      // Test implementation
      expect(result).toBe(expectedValue);
    });

    it('should handle edge case', () => {
      // Another test
    });
  });

  describe('anotherMethod', () => {
    it('should behave differently', () => {
      // More tests
    });
  });
});
```

**Patterns from codebase:**

1. **Global setup/teardown in `src/backend/testing/setup.ts`:**
   ```typescript
   import { afterEach, beforeEach, vi } from 'vitest';

   beforeEach(() => {
     vi.clearAllMocks();
   });

   afterEach(() => {
     vi.restoreAllMocks();
   });
   ```

2. **Nested describe blocks for logical grouping:**
   ```typescript
   describe('SessionManager', () => {
     describe('getProjectPath', () => {
       it('should escape forward slashes', () => { ... });
       it('should return correct path format', () => { ... });
     });

     describe('getSessionPath', () => {
       it('should combine project path with session ID', () => { ... });
     });
   });
   ```

3. **Section headers with comment blocks:**
   ```typescript
   // =============================================================================
   // sendUserMessage Tests
   // =============================================================================

   describe('sendUserMessage', () => {
     // Tests here
   });
   ```

## Mocking

**Framework:** Vitest's `vi` module

**Mock setup patterns:**

1. **Module mocks (set up before imports):**
   ```typescript
   const mockFindNeedingPRSync = vi.fn();
   const mockUpdate = vi.fn();

   vi.mock('../resource_accessors/workspace.accessor', () => ({
     workspaceAccessor: {
       findNeedingPRSync: () => mockFindNeedingPRSync(),
       update: (...args: unknown[]) => mockUpdate(...args),
     },
   }));

   // Import AFTER mocks are set up
   import { schedulerService } from './scheduler.service';
   ```

2. **Function mocks for specific behavior:**
   ```typescript
   mockFetchAndComputePRState.mockResolvedValue({
     prNumber: 1,
     prState: 'OPEN',
     prReviewState: 'APPROVED',
     prCiStatus: 'SUCCESS',
   });
   ```

3. **Conditional mock responses:**
   ```typescript
   mockFetchAndComputePRState
     .mockResolvedValueOnce({
       prNumber: 1,
       prState: 'OPEN',
       prReviewState: 'APPROVED',
       prCiStatus: 'SUCCESS',
     })
     .mockResolvedValueOnce(null); // Second call returns null
   ```

4. **Mock rejection for error cases:**
   ```typescript
   mockFindNeedingPRSync.mockRejectedValue(new Error('Database error'));
   ```

5. **Mock implementation for custom behavior:**
   ```typescript
   mockFetchAndComputePRState.mockImplementation(async () => {
     currentConcurrent++;
     maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
     await new Promise((resolve) => setTimeout(resolve, 10));
     currentConcurrent--;
     return { prNumber: 1, prState: 'OPEN', ... };
   });
   ```

**Naming Convention:**
- Mock functions: `mock{FunctionName}` (e.g., `mockFindNeedingPRSync`)
- Import real modules AFTER setting up mocks
- Use `vi.fn()` for function spies/mocks
- Use `vi.mock()` for module mocks

**What to Mock:**
- External service calls (database, API, file system)
- Third-party library functions
- Functions from other modules in dependency chain

**What NOT to Mock:**
- The function under test itself
- Pure utility functions
- Core JavaScript APIs (test real behavior instead)
- Built-in modules unless testing error handling

## Fixtures and Factories

**Test Data:**
- Inline object literals for simple test data
- Factory pattern for complex/repeated data structures

**Example from codebase:**
```typescript
it('should sync workspaces and return counts', async () => {
  const mockWorkspaces = [
    { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
    { id: 'ws-2', prUrl: 'https://github.com/org/repo/pull/2' },
  ];

  mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
  // ...test continues
});
```

**Location:**
- Test data defined in test file itself (not extracted to separate fixtures)
- Keeps test logic self-contained and readable
- Complex factories can be created as helper functions within test file

## Coverage

**Configuration:**
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'json-summary', 'html'],
  include: ['src/backend/**/*.ts'],
  exclude: ['src/backend/**/*.test.ts', 'src/backend/index.ts', 'src/backend/testing/**'],
  // Thresholds disabled - enable as coverage grows
},
```

**Requirements:** No enforced thresholds (commented in config)
- Coverage currently measured but not enforced
- Thresholds disabled because unit tests use heavy mocking
- Plan to enable as integration tests are added

**View Coverage:**
```bash
pnpm test:coverage
# Generates HTML report in coverage/ directory
```

## Test Types

**Unit Tests:**
- Test individual functions/methods in isolation
- Use mocks for all external dependencies
- Focus: logic, edge cases, error handling
- Example: `src/backend/claude/session.test.ts` tests `parseHistoryEntry()` function with various input combinations
- Example: `src/backend/clients/git.client.test.ts` tests `GitClient` methods with mocked exec

**Integration Tests:**
- Not currently emphasized (see coverage config notes)
- Would test multiple modules working together
- Could use real database with test transactions
- Planned for future as unit test coverage matures

**E2E Tests:**
- Not currently implemented
- Would test full user workflows end-to-end
- Infrastructure for this exists (Electron app) but no E2E test framework configured

## Common Patterns

**Async Testing:**
```typescript
it('should update workspace with PR status on success', async () => {
  mockFindNeedingPRSync.mockResolvedValue([
    { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/123' },
  ]);

  mockFetchAndComputePRState.mockResolvedValue({
    prNumber: 123,
    prState: 'MERGED',
    prReviewState: 'APPROVED',
    prCiStatus: 'SUCCESS',
  });

  await schedulerService.syncPRStatuses();

  expect(mockUpdate).toHaveBeenCalledWith('ws-1', {
    prNumber: 123,
    prState: 'MERGED',
    prReviewState: 'APPROVED',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: expect.any(Date),
  });
});
```

**Error Testing:**
```typescript
it('should handle exceptions during sync gracefully', async () => {
  const mockWorkspaces = [{ id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' }];

  mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
  mockFetchAndComputePRState.mockRejectedValue(new Error('Network error'));

  const result = await schedulerService.syncPRStatuses();

  expect(result).toEqual({ synced: 0, failed: 1 });
});
```

**Timer Testing (Fake Timers):**
```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

it('should run sync every 5 minutes when started', async () => {
  mockFindNeedingPRSync.mockResolvedValue([]);

  schedulerService.start();

  // First interval tick (5 minutes)
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(1);

  // Second interval tick
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(2);

  await schedulerService.stop();
});

// For tests needing real async:
it('should respect rate limit', async () => {
  vi.useRealTimers();

  // Test with real async behavior

  vi.useFakeTimers(); // Restore fake timers
});
```

**Concurrent Behavior Testing:**
```typescript
it('should respect rate limit of 5 concurrent syncs', async () => {
  const mockWorkspaces = Array.from({ length: 10 }, (_, i) => ({
    id: `ws-${i}`,
    prUrl: `https://github.com/org/repo/pull/${i}`,
  }));

  mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);

  let currentConcurrent = 0;
  let maxConcurrent = 0;

  mockFetchAndComputePRState.mockImplementation(async () => {
    currentConcurrent++;
    maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    currentConcurrent--;
    return { /* data */ };
  });

  vi.useRealTimers();
  const result = await schedulerService.syncPRStatuses();
  vi.useFakeTimers();

  expect(maxConcurrent).toBeLessThanOrEqual(5);
  expect(maxConcurrent).toBeGreaterThan(0);
});
```

**Edge Cases and Boundaries:**
```typescript
describe('edge cases', () => {
  it('should return empty array for unknown entry types', () => {
    const entry = { type: 'unknown', timestamp, message: { role: 'user', content: 'Should be ignored' } };
    const result = parseHistoryEntry(entry);
    expect(result).toHaveLength(0);
  });

  it('should return empty array for entries without message field', () => {
    const entry = { type: 'user', timestamp };
    const result = parseHistoryEntry(entry);
    expect(result).toHaveLength(0);
  });

  it('should handle null and undefined messages', () => {
    expect(parseHistoryEntry({ type: 'user', timestamp, message: null })).toHaveLength(0);
    expect(parseHistoryEntry({ type: 'user', timestamp, message: undefined })).toHaveLength(0);
  });

  it('should handle empty content array', () => {
    const entry = { type: 'user', timestamp, message: { role: 'user', content: [] } };
    const result = parseHistoryEntry(entry);
    expect(result).toHaveLength(0);
  });
});
```

## Test Cleanup

**Setup file (`src/backend/testing/setup.ts`):**
- Runs for every test file automatically
- Clears all mocks before each test
- Restores all mocks after each test
- Prevents mock state from leaking between tests

**Best practices:**
- Call `vi.clearAllMocks()` in `beforeEach` to reset mock call counts
- Call `vi.restoreAllMocks()` in `afterEach` to remove all mocks
- Use `vi.useRealTimers()` and `vi.useFakeTimers()` carefully (restore after use)
- Close database connections in `afterEach` if testing with real database

---

*Testing analysis: 2026-01-29*
