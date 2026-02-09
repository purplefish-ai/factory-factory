# Testing Patterns

**Analysis Date:** 2026-02-09

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`
- Environment: Node.js (server-side tests only, no DOM)
- Globals: Enabled (no need to import describe/it/expect)

**Assertion Library:**
- Vitest built-in expect (similar to Jest)

**Run Commands:**
```bash
pnpm test              # Run all tests once
pnpm test:watch       # Run tests in watch mode (re-run on file changes)
pnpm test:coverage    # Generate coverage report
```

## Test File Organization

**Location:**
- Co-located with implementation: same directory as source file
- Pattern: `feature.ts` → `feature.test.ts`

**Naming:**
- Suffix: `.test.ts` for all test files
- Examples: `session.test.ts`, `git.client.test.ts`, `workspace.trpc.test.ts`

**Structure:**
```
src/backend/
├── services/
│   ├── git-ops.service.ts
│   └── git-ops.service.test.ts
├── clients/
│   ├── git.client.ts
│   └── git.client.test.ts
└── routers/
    ├── workspace.trpc.ts
    └── workspace.trpc.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from 'vitest';
import { functionToTest } from './module';

describe('module-or-function-name', () => {
  describe('specific-feature', () => {
    it('should do something specific', () => {
      // Test implementation
    });

    it('should handle edge case', () => {
      // Test implementation
    });
  });

  describe('another-feature', () => {
    it('should ...', () => {
      // Test implementation
    });
  });
});
```

**Patterns:**
- Outer `describe` groups by module/class name
- Nested `describe` groups by method/function name or feature area
- Each `it` tests one specific behavior with assertion messages

**Setup and Teardown:**
- `beforeEach()`: Runs before each test
- `afterEach()`: Runs after each test
- Global setup: `src/backend/testing/setup.ts`

**Setup File (executed before all tests):**
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

**Test Pattern Example from `conversation-analyzer.test.ts`:**
```typescript
describe('conversation-analyzer', () => {
  describe('countUserMessages', () => {
    it('should count only user messages', () => {
      const history: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'assistant', content: 'Hi', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'user', content: 'How are you?', timestamp: '2024-01-01T00:00:02Z' },
      ];

      expect(countUserMessages(history)).toBe(2);
    });

    it('should return 0 for empty history', () => {
      expect(countUserMessages([])).toBe(0);
    });
  });
});
```

## Mocking

**Framework:** Vitest's `vi` module (built-in, no additional import needed)

**Patterns:**

**1. Mock entire modules before imports:**
```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies BEFORE importing the module under test
const mockFindById = vi.fn();
const mockGetTerminal = vi.fn();

vi.mock('../../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('../../services/terminal.service', () => ({
  terminalService: {
    getTerminal: (...args: unknown[]) => mockGetTerminal(...args),
    getTerminalsForWorkspace: (...args: unknown[]) => mockGetTerminalsForWorkspace(...args),
  },
}));

// Import AFTER mocks are set up
import { registerTerminalTools } from './terminal.mcp';
```

**2. Configure mock return values in beforeEach:**
```typescript
beforeEach(() => {
  vi.clearAllMocks();

  // Default mock for session lookup
  mockFindById.mockResolvedValue({
    workspaceId: mockWorkspaceId,
    workspace: { id: mockWorkspaceId, name: 'test' },
  });
});
```

**3. Spy on functions without mocking:**
```typescript
const spy = vi.spyOn(service, 'method');
expect(spy).toHaveBeenCalledWith(arg);
```

**4. Mock return values for specific test:**
```typescript
it('should handle terminal not found', async () => {
  mockGetTerminal.mockResolvedValueOnce(null);

  const result = await executeGetOutput(agentId, { terminalId: 'missing' });

  expect(result.success).toBe(false);
});
```

**What to Mock:**
- External service calls (GitHub CLI, git commands)
- Database accessors
- File system operations (in some cases)
- Logger calls
- Dependencies that have side effects

**What NOT to Mock:**
- Pure functions (keep real implementations)
- Zod schemas (validate against real schema)
- Utility helpers that don't have side effects
- Time-dependent functions in integration tests (use real time)

## Fixtures and Factories

**Test Data:**
```typescript
// Helper factory from terminal.mcp.test.ts
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

// Usage
const mockTerminal = createMockTerminal({ id: 'custom-id' });
```

**Sample Constant Test Data from `permissions.test.ts`:**
```typescript
const canUseToolRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'Read',
  input: { file_path: '/test.txt' },
  tool_use_id: 'tool-123',
};

const hookCallbackRequest: HookCallbackRequest = {
  subtype: 'hook_callback',
  callback_id: 'callback-123',
  tool_use_id: 'tool-456',
  input: {
    session_id: 'session-123',
    transcript_path: '/path/to/transcript',
    cwd: '/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/test.txt' },
  },
};
```

**Location:**
- Inline in test file as constants for simple fixtures
- Exported from test utility modules for complex fixtures
- No separate fixtures directory; keep data close to tests

## Coverage

**Requirements:** Not enforced (thresholds disabled)

**View Coverage:**
```bash
pnpm test:coverage
```

**Coverage Configuration from `vitest.config.ts`:**
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'json-summary', 'html'],
  include: ['src/backend/**/*.ts'],
  exclude: ['src/backend/**/*.test.ts', 'src/backend/index.ts', 'src/backend/testing/**'],
  // Thresholds disabled for now since unit tests use mocks
  // Enable as integration tests are added and coverage grows
}
```

**Note:** Tests use mocks extensively for unit testing. Coverage thresholds are intentionally disabled pending shift to more integration tests. Frontend tests not included in coverage metrics.

## Test Types

**Unit Tests:**
- Scope: Single function/method in isolation
- Approach: Mock all external dependencies
- Examples: `git-helpers.test.ts`, `conversation-analyzer.test.ts`
- Assertion style: Direct, specific assertions on return values and mock calls

**Integration Tests:**
- Scope: Multiple components working together
- Approach: Mock only external services (GitHub, git commands), keep business logic real
- Examples: `workspace.trpc.test.ts`, `terminal.mcp.test.ts`
- Status: Growing coverage; thresholds disabled until integration tests mature

**E2E Tests:**
- Framework: Not used in this codebase
- Status: No end-to-end tests present

## Common Patterns

**Async Testing:**
```typescript
it('should handle async operations', async () => {
  mockFindById.mockResolvedValue({ id: '123' });

  const result = await asyncFunction();

  expect(result).toBeDefined();
  expect(mockFindById).toHaveBeenCalled();
});

// Alternative: returning Promise from test function
it('should handle promise', () => {
  return asyncFunction().then(result => {
    expect(result).toBeDefined();
  });
});
```

**Error Testing:**
```typescript
it('should throw error on invalid input', () => {
  expect(() => {
    new GitClient({ baseRepoPath: '', worktreeBase: '/test' });
  }).toThrow('baseRepoPath is required');
});

// For async errors
it('should reject on git failure', async () => {
  const statusResult = { code: 1, stderr: 'fatal error', stdout: '' };
  mockGitCommand.mockResolvedValueOnce(statusResult);

  await expect(gitOpsService.commitIfNeeded(path, name, true))
    .rejects
    .toThrow('Git status failed');
});
```

**Array and Object Assertions from `workspace.trpc.test.ts`:**
```typescript
it('should parse multiple files with different statuses', () => {
  const output = [
    'M  src/staged-modified.ts',
    ' M src/unstaged-modified.ts',
    'A  src/added.ts',
  ].join('\n');

  const result = parseGitStatusOutput(output);

  expect(result).toEqual([
    { path: 'src/staged-modified.ts', status: 'M', staged: true },
    { path: 'src/unstaged-modified.ts', status: 'M', staged: false },
    { path: 'src/added.ts', status: 'A', staged: true },
  ]);
});
```

**Type Checking in Tests:**
```typescript
it('should parse user message with tool_result content', () => {
  const entry = { ... };
  const result = parseHistoryEntry(entry);

  expect(result).toHaveLength(1);
  const first = result[0];
  expect(first?.type).toBe('tool_result');

  // Type guard for subsequent assertions
  if (first?.type !== 'tool_result') {
    throw new Error('Expected tool_result message');
  }
  expect(first.toolId).toBe('tool-123');
  expect(first.isError).toBe(false);
});
```

**Non-null Assertion in Tests:**
```typescript
// From biome.json, noNonNullAssertion is "off" for test files
it('should handle data', () => {
  const result = getData();
  expect(result[0]!.property).toBe(value); // ! is allowed in tests
});
```

## Test Coverage Considerations

**Excluded from Coverage:**
- `src/backend/index.ts` - Entry point setup
- `src/backend/**/*.test.ts` - Test files themselves
- `src/backend/testing/**` - Test utilities and setup

**High Coverage Areas:**
- Service layer (git-ops, terminal, github-cli)
- Utility/helper functions
- Error handling and validation
- Message parsing and transformation

**Lower Coverage Areas:**
- Frontend React components (no unit tests present)
- WebSocket handlers (integration-heavy)
- MCP tool registration (integration-heavy)

## Running Tests During Development

**Watch mode for rapid iteration:**
```bash
pnpm test:watch
```

**Run specific test file:**
```bash
pnpm test src/backend/services/git-ops.service.test.ts
```

**Run tests matching pattern:**
```bash
pnpm test -- --grep "parseHistoryEntry"
```

---

*Testing analysis: 2026-02-09*
