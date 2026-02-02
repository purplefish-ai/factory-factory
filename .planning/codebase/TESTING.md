# Testing Patterns

**Analysis Date:** 2026-02-01

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts` at root
- Environment: Node.js (not browser/jsdom)

**Assertion Library:**
- Vitest's built-in expect (extends Chai assertions)

**Run Commands:**
```bash
pnpm test              # Run all tests (one-shot)
pnpm test:watch       # Watch mode for development
pnpm test:coverage    # Generate coverage report
```

## Test File Organization

**Location:**
- Co-located with source files
- Pattern: `[module].test.ts` in same directory as `[module].ts`
- Test file included in coverage but excluded via `include` pattern in vitest.config.ts

**Naming:**
- `*.test.ts` for backend tests
- `*.test.tsx` for component tests (if added)
- Match source filename exactly: `git.client.ts` → `git.client.test.ts`

**Structure:**
```
src/
├── backend/
│   ├── clients/
│   │   ├── git.client.ts
│   │   └── git.client.test.ts
│   ├── services/
│   │   ├── logger.service.ts
│   │   └── logger.service.test.ts (if tested)
│   └── testing/
│       └── setup.ts             # Global test setup
```

**Include pattern (vitest.config.ts):**
```typescript
include: ['src/**/*.test.ts']
```

## Test Structure

**Suite Organization:**

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

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
      expect(() => new GitClient({ baseRepoPath: '', worktreeBase: '/test' }))
        .toThrow('baseRepoPath is required');
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

**Patterns:**
- Use `describe()` to organize tests into logical groups
- Nested `describe()` for related functionality (constructor, getWorktreePath, etc.)
- `beforeEach()` for test setup (create fresh instances)
- `afterEach()` for cleanup (mocks reset automatically)
- Section comments with `// ========` for readability in large suites

**Examples from codebase:**
- `src/backend/clients/git.client.test.ts` - 150+ line client tests with constructor, method, and edge case tests
- `src/backend/trpc/workspace.trpc.test.ts` - Focused function tests (`parseGitStatusOutput`)
- `src/backend/claude/session.test.ts` - SessionManager static method tests

## Mocking

**Framework:** Vitest (`vi` namespace)

**Patterns - Module Mocking:**

```typescript
// Mock dependencies BEFORE importing module under test
const mockFindById = vi.fn();

vi.mock('../../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

// Import AFTER setting up mocks
import { executeMcpTool } from './server';
```

**Setup in beforeEach():**
```typescript
beforeEach(() => {
  // Reset all mocks before each test
  vi.clearAllMocks();

  // Set up default mock return values
  mockFindById.mockResolvedValue({
    workspaceId: mockWorkspaceId,
    workspace: { /* ... */ },
  });
});
```

**Verification:**
```typescript
expect(mockGetTerminal).toHaveBeenCalledWith(mockWorkspaceId, 'term-specific');
expect(mockRes.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
```

**Global Setup:**
- File: `src/backend/testing/setup.ts`
- Runs before all test suites
- Clears all mocks in beforeEach
- Restores all mocks in afterEach

**What to Mock:**
- External dependencies: database (Prisma), file system, git commands
- Services that are tested separately
- Network calls (HTTP requests)
- Time-dependent functions: `Date.now()`, timers

**What NOT to Mock:**
- Pure utility functions (math, string parsing, data transformation)
- Functions under test that have no external dependencies
- Business logic that demonstrates the feature

**Examples from codebase:**
- `git.client.test.ts` - No mocking; tests pure functions (path generation, branch name validation)
- `terminal.mcp.test.ts` - Mocks: `claudeSessionAccessor`, `terminalService`, `logger.service`
- `middleware.test.ts` - Mocks Express Request/Response objects via helper functions

## Fixtures and Factories

**Test Data - Helper Functions:**

```typescript
// From terminal.mcp.test.ts
function createMockTerminal(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    outputBuffer: string;
    createdAt: Date;
    cols: number;
    rows: number;
    pid: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'term-123',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    outputBuffer: overrides.outputBuffer ?? 'line1\nline2\nline3',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    pty: {
      pid: overrides.pid ?? 12_345,
    },
    disposables: [],
  };
}
```

**Helper Functions for Mock Setup:**

```typescript
// From middleware.test.ts
function createMockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    path: '/api/test',
    headers: {},
    ...overrides,
  } as Request;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    header: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
  };
}
```

**Location:**
- Defined at top of test file after imports
- Helper functions defined AFTER vi.mock() calls
- Exported from test file only if used in multiple test files (rare)

## Coverage

**Requirements:** No thresholds currently enforced (noted in vitest.config.ts)

**View Coverage:**
```bash
pnpm test:coverage
```

**Output:**
- Provider: v8
- Reporters: text, json, json-summary, html
- Include: `src/backend/**/*.ts`
- Exclude: `src/backend/**/*.test.ts`, `src/backend/index.ts`, `src/backend/testing/**`

**Notes:** Coverage is disabled for unit tests that use mocks. Integration tests expected to increase coverage in future phases.

## Test Types

**Unit Tests:**
- Scope: Single function or class method
- Approach: Test pure logic with minimal dependencies
- Mocking: Mock external dependencies
- Examples:
  - `git.client.test.ts` - Tests `isAutoGeneratedBranchName()`, `generateBranchName()`, path methods
  - `git-helpers.test.ts` - Tests `parseGitStatusOutput()`, `parseNumstatOutput()`

**Integration Tests:**
- Scope: Multiple components working together
- Approach: Test real service interactions with mocked I/O
- Mocking: Mock only external systems (database, network)
- Status: Not yet implemented, coverage thresholds to be enabled when added

**E2E Tests:**
- Status: Not implemented
- Framework: None configured

## Common Patterns

**Async Testing:**

```typescript
// From session.test.ts
describe('getProjectPath', () => {
  it('should escape forward slashes with hyphens', () => {
    const path = SessionManager.getProjectPath('/Users/test/project');
    expect(path).toContain('-Users-test-project');
  });
});

// For async operations
describe('async operations', () => {
  it('should resolve successfully', async () => {
    const result = await asyncFunction();
    expect(result).toBeDefined();
  });
});
```

**Error Testing:**

```typescript
// From git.client.test.ts
it('should throw if baseRepoPath is missing', () => {
  expect(() => new GitClient({ baseRepoPath: '', worktreeBase: '/test' }))
    .toThrow('baseRepoPath is required');
});

// For async error handling
it('should reject with specific error', async () => {
  await expect(asyncErrorFunc()).rejects.toThrow('Error message');
});
```

**Multiple Assertions:**

```typescript
// From session.test.ts
it('should extract session_id correctly', () => {
  const msg: ClaudeJson = {
    type: 'assistant',
    session_id: 'abc123',
    message: { role: 'assistant', content: [] },
  };

  expect(SessionManager.extractClaudeSessionId(msg)).toBe('abc123');
});

// Multiple related assertions in one test
it('should parse file status correctly', () => {
  const result = parseGitStatusOutput(' M README.md\n');

  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({
    path: 'README.md',
    status: 'M',
    staged: false,
  });
});
```

**Boundary Testing:**

```typescript
// From git.client.test.ts
describe('edge cases', () => {
  it('should handle empty prefix by generating just hash', () => {
    const name = client.generateBranchName('');
    expect(name).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should handle single character workspace name', () => {
    const path = client.getWorktreePath('x');
    expect(path).toBe('/test/worktrees/x');
  });

  it('should handle long workspace names', () => {
    const longName = 'a'.repeat(100);
    const path = client.getWorktreePath(longName);
    expect(path).toBe(`/test/worktrees/${longName}`);
  });
});
```

## Test Execution

**Command Breakdown:**

```bash
# Watch mode: Re-run tests on file changes
pnpm test:watch

# Single run with output
pnpm test run

# Coverage report with HTML
pnpm test:coverage
# View at: coverage/index.html
```

**Parallel Execution:**
- Vitest runs tests in parallel by default
- Global setup runs once before all test suites
- Each test file has isolated globals (new mocks per file)

---

*Testing analysis: 2026-02-01*
