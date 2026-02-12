# Testing Patterns

**Analysis Date:** 2026-02-10

## Test Framework

**Runner:**
- Vitest v4.0.18
- Config: `vitest.config.ts`
- Environment: Node.js (`environment: 'node'`)

**Assertion Library:**
- Vitest built-in expect API: `expect(actual).toBe(expected)`

**Run Commands:**
```bash
pnpm test              # Run all tests (vitest run)
pnpm test:watch       # Watch mode with auto-rerun
pnpm test:coverage    # Generate coverage report
```

## Test File Organization

**Location:**
- Co-located with source files, same directory
- Tests live alongside the module they test

**Naming:**
- `{module}.test.ts` for TypeScript modules (e.g., `git.client.test.ts`, `file-helpers.test.ts`)
- `{module}.test.tsx` for React components (e.g., `use-workspace-list-state.test.ts`)

**File Pattern:**
```
src/backend/
├── services/
│   ├── chat-connection.service.ts
│   └── chat-connection.service.test.ts  ← same directory
├── clients/
│   ├── git.client.ts
│   └── git.client.test.ts
└── lib/
    ├── file-helpers.ts
    └── file-helpers.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ModuleName', () => {
  describe('methodName', () => {
    beforeEach(() => {
      // Setup
    });

    afterEach(() => {
      // Cleanup
    });

    it('should do something', () => {
      // Arrange
      const input = ...;

      // Act
      const result = method(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

**Patterns:**

1. **Describe blocks for organization:**
   - Top-level describe for the class/module
   - Nested describe for each method or logical grouping
   - Describe blocks for categories (e.g., "safe paths", "path traversal attempts", "symlink scenarios")

2. **Setup/Teardown:**
   - `beforeEach()` - runs before each test
   - `afterEach()` - runs after each test
   - Use `vi.clearAllMocks()` in beforeEach
   - Use `vi.resetAllMocks()` in afterEach for complete reset

3. **Test naming:**
   - Start with "should" or "when": `should create a client with valid config`
   - Describe the behavior being tested: `should throw if baseRepoPath is missing`
   - Clear about the expected outcome

**Example from git.client.test.ts:**
```typescript
describe('GitClient', () => {
  const testConfig = {
    baseRepoPath: '/test/repo',
    worktreeBase: '/test/worktrees',
  };

  let client: GitClient;

  beforeEach(() => {
    client = new GitClient(testConfig);
  });

  describe('constructor', () => {
    it('should create a client with valid config', () => {
      expect(client).toBeInstanceOf(GitClient);
    });

    it('should throw if baseRepoPath is missing', () => {
      expect(() => new GitClient({ baseRepoPath: '', worktreeBase: '/test' })).toThrow(
        'baseRepoPath is required'
      );
    });
  });

  describe('getWorktreePath', () => {
    it('should return correct path', () => {
      const path = client.getWorktreePath('my-workspace');
      expect(path).toBe('/test/worktrees/my-workspace');
    });
  });
});
```

## Mocking

**Framework:** Vitest's `vi` object for mocking

**Patterns:**

1. **Module mocking with `vi.mock()`:**
   - Mock entire modules before import
   - Use `vi.hoisted()` to create mocks in same scope
   - Example from `chat-message-handlers.service.test.ts`:
```typescript
const { mockSessionDomainService, mockSessionService } = vi.hoisted(() => ({
  mockSessionDomainService: {
    dequeueNext: vi.fn(),
    requeueFront: vi.fn(),
    markError: vi.fn(),
    markIdle: vi.fn(),
    markRunning: vi.fn(),
    allocateOrder: vi.fn(),
    emitDelta: vi.fn(),
    commitSentUserMessageAtOrder: vi.fn(),
    getQueueLength: vi.fn(),
  },
  mockSessionService: {
    getClient: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: mockSessionDomainService,
}));

vi.mock('./session.service', () => ({
  sessionService: mockSessionService,
}));

// Then import after mocks are defined
import { chatMessageHandlerService } from './chat-message-handlers.service';
```

2. **Method mocking on instances:**
   - Assign mock functions to properties: `client.branchExists = () => Promise.resolve(false)`
   - Use `vi.fn()` with return value setups
   - Example from git.client.test.ts:
```typescript
describe('generateUniqueBranchName', () => {
  it('should return base name when branch does not exist', async () => {
    client.branchExists = () => Promise.resolve(false);

    const name = await client.generateUniqueBranchName('martin-purplefish', 'jaguar');
    expect(name).toBe('martin-purplefish/jaguar');
  });

  it('should increment until finding available name', async () => {
    const existingNames = new Set([
      'martin-purplefish/jaguar',
      'martin-purplefish/jaguar-1',
      'martin-purplefish/jaguar-2',
    ]);

    client.branchExists = (branchName: string) => Promise.resolve(existingNames.has(branchName));

    const name = await client.generateUniqueBranchName('martin-purplefish', 'jaguar');
    expect(name).toBe('martin-purplefish/jaguar-3');
  });
});
```

3. **Function mocking with implementation control:**
   - Use `vi.fn().mockReturnValue()`, `vi.fn().mockResolvedValue()`, `vi.fn().mockRejectedValue()`
   - Use `vi.fn().mockImplementation()` for custom behavior
   - Example from file-helpers.test.ts:
```typescript
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(),
  stat: vi.fn(),
}));

import { realpath, stat } from 'node:fs/promises';
const mockedRealpath = vi.mocked(realpath);
const mockedStat = vi.mocked(stat);

describe('isPathSafe', () => {
  it('should allow existing files within worktree', async () => {
    mockedRealpath.mockImplementation((p) => {
      if (p === path.resolve(worktreePath, 'src/index.ts')) {
        return Promise.resolve(path.resolve(worktreePath, 'src/index.ts'));
      }
      if (p === path.resolve(worktreePath)) {
        return Promise.resolve(path.resolve(worktreePath));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await isPathSafe(worktreePath, 'src/index.ts');
    expect(result).toBe(true);
  });
});
```

**What to Mock:**
- External dependencies (file system, network, databases)
- Services that have their own tests
- Third-party library calls
- Time-dependent operations (use `vi.useFakeTimers()`)

**What NOT to Mock:**
- The module under test
- Utility functions used by the module
- Core logic flow (unless testing error paths)
- Pure functions within the same module

## Fixtures and Factories

**Test Data:**
- Create objects inline in test blocks for clarity
- Use factory functions for complex objects

**Example from chat-message-handlers.service.test.ts:**
```typescript
const queuedMessage: QueuedMessage = {
  id: 'm1',
  text: 'hello',
  timestamp: '2026-02-01T00:00:00.000Z',
  settings: {
    selectedModel: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  },
};

// Reused in multiple tests
beforeEach(() => {
  mockSessionDomainService.dequeueNext.mockReturnValue(queuedMessage);
  mockSessionDomainService.allocateOrder.mockReturnValue(0);
});
```

**Location:**
- Test data defined at top of test file or in beforeEach
- No separate fixtures directory currently used
- Keep test data close to tests using it

## Coverage

**Requirements:**
- No enforced threshold currently
- Comment in config: "Thresholds disabled for now since unit tests use mocks. Enable as integration tests are added and coverage grows."

**View Coverage:**
```bash
pnpm test:coverage
# Generates: coverage/index.html for browsing results
```

**Configuration in vitest.config.ts:**
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'json-summary', 'html'],
  include: ['src/backend/**/*.ts'],
  exclude: ['src/backend/**/*.test.ts', 'src/backend/index.ts', 'src/backend/testing/**'],
}
```

## Test Types

**Unit Tests:**
- Focus: Testing individual functions/methods in isolation
- Scope: Single module or small logical unit
- Examples: git.client.test.ts, file-helpers.test.ts
- Mocking: Mock external dependencies
- Speed: Fast (milliseconds)
- Reality: Use mocks heavily; don't test integration with actual services

**Integration Tests:**
- Focus: Testing interaction between multiple modules
- Status: Not yet implemented (comment in config)
- Plan: Will be added as coverage grows

**E2E Tests:**
- Status: Not used (frontend only, no dedicated E2E test suite)
- Coverage: Manual testing or CI integration tests

## Common Patterns

**Async Testing:**
```typescript
it('should work asynchronously', async () => {
  // Using await
  const result = await asyncFunction();
  expect(result).toBe(expected);
});

// Or using Promise chains
it('should resolve correctly', () => {
  return expect(asyncFunction()).resolves.toBe(expected);
});

// Or using async/await with expect
it('should return correct value', async () => {
  await expect(asyncFunction()).resolves.toBe(expected);
});
```

**Error Testing:**
```typescript
// Test that function throws
it('should throw if baseRepoPath is missing', () => {
  expect(() => new GitClient({ baseRepoPath: '', worktreeBase: '/test' })).toThrow(
    'baseRepoPath is required'
  );
});

// Test async error with mocks
it('reverts runtime to idle when dispatch fails after markRunning', async () => {
  const client = {
    sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
    // ... other methods
  };
  mockSessionService.getClient.mockReturnValue(client);

  await chatMessageHandlerService.tryDispatchNextMessage('s1');

  expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
  expect(mockSessionDomainService.markIdle).toHaveBeenCalledWith('s1', 'alive');
  expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
});
```

**Mocking Stateful Behavior:**
```typescript
it('should increment until finding available name', async () => {
  let callCount = 0;
  client.branchExists = (_branchName: string) => {
    callCount++;
    // First call: base name exists
    if (callCount === 1) {
      return Promise.resolve(true);
    }
    // Second call: -1 doesn't exist
    return Promise.resolve(false);
  };

  const name = await client.generateUniqueBranchName('martin-purplefish', 'jaguar');
  expect(name).toBe('martin-purplefish/jaguar-1');
});
```

**Parametrized Tests:**
```typescript
describe('isAutoGeneratedBranchName', () => {
  describe('hex-only branches (no prefix)', () => {
    it('should match 6 hex characters', () => {
      expect(isAutoGeneratedBranchName('abc123')).toBe(true);
      expect(isAutoGeneratedBranchName('000000')).toBe(true);
      expect(isAutoGeneratedBranchName('ffffff')).toBe(true);
      expect(isAutoGeneratedBranchName('a1b2c3')).toBe(true);
    });

    it('should not match non-hex characters', () => {
      expect(isAutoGeneratedBranchName('ghijkl')).toBe(false);
      expect(isAutoGeneratedBranchName('xyz123')).toBe(false);
    });
  });
});
```

## Setup and Teardown

**File-Level Setup:**
From `src/backend/testing/setup.ts`:
```typescript
import { afterEach, beforeEach, vi } from 'vitest';

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

This file is configured as `setupFiles` in vitest.config.ts, ensuring all tests get clean mocks.

**Test-Specific Setup:**
- Use beforeEach/afterEach in describe blocks for test-specific setup
- Example:
```typescript
describe('isPathSafe', () => {
  const worktreePath = '/home/user/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });
});
```

## Testing Guidelines

**When Testing Exception Handling:**
- Verify the correct exception type and message
- Verify error recovery (how the system handles the error)
- Mock the failure condition
- Assert both the error and any cleanup actions

**When Testing State Changes:**
- Verify state before action
- Perform action
- Verify state after (or side effects)
- Use mocked methods to track state changes: `expect(mockService.method).toHaveBeenCalledWith(...)`

**When Testing Async Operations:**
- Always await or use `.resolves`/`.rejects`
- Mock any async dependencies with `mockResolvedValue()` or `mockRejectedValue()`
- Verify both success and failure paths

**Biome Linting Exceptions for Tests:**
- Non-null assertions allowed in tests: `value!` (rule disabled in `*.test.ts` files)
- This allows tests to be more concise while keeping assertions strict in production code

---

*Testing analysis: 2026-02-10*
