# Testing Patterns

**Analysis Date:** 2026-02-01

## Test Framework

**Runner:**
- Vitest v4.0.18
- Config: `vitest.config.ts`
- Environment: Node.js (not browser)
- Globals enabled: `describe()`, `it()`, `beforeEach()`, `afterEach()`, `expect()` available without imports

**Assertion Library:**
- Vitest built-in assertions via `expect()`
- No external assertion library needed
- Compatible with Chai/Vitest matchers

**Run Commands:**
```bash
pnpm test              # Run all tests once
pnpm test:watch        # Watch mode with hot reload
pnpm test:coverage     # Run tests with coverage report
```

**Coverage:**
- Provider: V8
- Include: `src/backend/**/*.ts`
- Exclude: `src/backend/**/*.test.ts`, `src/backend/index.ts`, `src/backend/testing/**`
- Reporters: text, json, json-summary, html
- Thresholds: Currently disabled (unit tests use heavy mocking; enable as integration tests grow)
- View coverage: Open `coverage/index.html` after `pnpm test:coverage`

## Test File Organization

**Location:**
- Co-located with source: tests live next to implementation
- Pattern: `src/backend/services/port.service.ts` has test file `src/backend/services/port.service.test.ts`
- Test discovery: `vitest.config.ts` includes `src/**/*.test.ts`

**Naming:**
- Format: `kebab-case.test.ts` (e.g., `session.test.ts`, `port.service.test.ts`)
- Alternate: `kebab-case.spec.ts` (not observed in this codebase but supported)

**Structure:**
```
src/
├── backend/
│   ├── services/
│   │   ├── port.service.ts
│   │   ├── port.service.test.ts
│   │   ├── logger.service.ts
│   │   └── ...
│   ├── lib/
│   │   ├── git-helpers.ts
│   │   ├── git-helpers.test.ts
│   │   └── ...
│   ├── testing/
│   │   └── setup.ts              # Global test setup
│   └── ...
```

## Test Structure

**Suite Organization:**
```typescript
// src/backend/claude/session.test.ts
import { describe, expect, it } from 'vitest';
import { parseHistoryEntry, SessionManager } from './session';

describe('SessionManager', () => {
  describe('getProjectPath', () => {
    it('should escape forward slashes with hyphens', () => {
      const path = SessionManager.getProjectPath('/Users/test/project');
      expect(path).toContain('-Users-test-project');
    });

    it('should return correct path format under .claude/projects', () => {
      const path = SessionManager.getProjectPath('/home/user/myproject');
      expect(path).toBe(join(homedir(), '.claude', 'projects', '-home-user-myproject'));
    });
  });

  describe('extractClaudeSessionId', () => {
    // ... more tests
  });
});

describe('parseHistoryEntry', () => {
  // ... separate describe block for function
});
```

**Patterns:**
- Use `describe()` to organize related tests into suites
- Nest `describe()` blocks for hierarchical grouping
- Each test case in own `it()` block with descriptive name
- One assertion focus per test (or related assertions that form one concept)
- Separate `describe()` blocks for different functions/classes
- Test names follow pattern: "should [behavior] when [condition]"

## Setup and Teardown

**Global Setup:**
- File: `src/backend/testing/setup.ts`
- Runs once before all tests

```typescript
// src/backend/testing/setup.ts
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

**Per-Test Setup/Teardown:**
```typescript
describe('port.service', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer.once.mockReset();
    mockServer.listen.mockReset();
    mockServer.close.mockReset();
    mockExec.mockReset();
  });

  afterEach(() => {
    // Restore original platform after each test
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  it('should...', () => {
    // Test body
  });
});
```

**Patterns:**
- Clear mocks between tests in `beforeEach()`
- Restore original state in `afterEach()`
- Save original values before modifying: `const originalPlatform = process.platform`
- Use `vi.clearAllMocks()` to reset all mocks at once
- Use `vi.restoreAllMocks()` to restore original implementations

## Mocking

**Framework:** Vitest's `vi` module

**Mock Module Dependencies:**
```typescript
// Mock before importing module that uses it
const mockServer = {
  once: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
};

const mockCreateNetServer = vi.fn(() => mockServer);
const mockExec = vi.fn();

vi.mock('node:net', () => ({
  createServer: () => mockCreateNetServer(),
}));

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

// Import after mocks are set up
import { findAvailablePort, isPortAvailable } from './port.service';
```

**Mock Return Values:**
```typescript
// Simple return value
mockExec.mockResolvedValue({ stdout: '', stderr: '' });

// Conditional return based on call count
let callCount = 0;
mockExec.mockImplementation(() => {
  const currentPort = 3000 + callCount;
  callCount++;

  if (currentPort < 3003) {
    return Promise.resolve({ stdout: '12345\n', stderr: '' });
  }
  return Promise.resolve({ stdout: '', stderr: '' });
});

// Throw on specific calls
mockExec.mockRejectedValue(new Error('lsof: command not found'));
```

**Mock Assertions:**
```typescript
// Verify mock was called with correct arguments
expect(mockServer.listen).toHaveBeenCalledWith(3000);

// Verify mock was NOT called
expect(mockExec).not.toHaveBeenCalled();

// Verify mock call count
expect(attemptCount).toBe(3);
```

**What to Mock:**
- External modules (`node:net`, `node:child_process`, database clients)
- Third-party services (GitHub API, Claude client)
- Complex dependencies that are slow or have side effects
- Platform-specific behavior (process.platform, file system calls)

**What NOT to Mock:**
- Pure utility functions (prefer to test with real implementations)
- Simple helper libraries
- Types and interfaces
- Functions from the module under test (test real implementations)

**Mock Service Pattern:**
```typescript
// src/backend/services/port.service.test.ts
vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
```

## Fixtures and Factories

**Test Data:**
- Use literal objects for simple test cases
- Create factory functions for complex test data

```typescript
// src/backend/claude/session.test.ts
describe('parseHistoryEntry', () => {
  const timestamp = '2025-01-25T10:00:00Z';

  it('should parse user message with string content', () => {
    const entry = {
      type: 'user',
      timestamp,
      uuid: 'uuid-123',
      message: {
        role: 'user',
        content: 'Hello, Claude!',
      },
    };
    const result = parseHistoryEntry(entry);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
  });

  it('should parse tool_use content', () => {
    const entry = {
      type: 'assistant',
      timestamp,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-123',
            name: 'Read',
            input: { file_path: '/test.txt' },
          },
        ],
      },
    };
    const result = parseHistoryEntry(entry);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('Read');
  });
});
```

**Location:**
- Inline test data in test files (keep tests self-contained)
- Shared fixtures in `src/backend/testing/fixtures/` if reused across multiple test files
- Factory functions co-located with related tests or in `src/backend/testing/`

## Common Test Patterns

**Async Testing:**
```typescript
it('should return true when port is available', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mockExec.mockResolvedValue({ stdout: '', stderr: '' });

  const result = await isPortAvailable(3000);

  expect(result).toBe(true);
  expect(mockExec).toHaveBeenCalledWith('lsof -i :3000 -sTCP:LISTEN -t', {
    timeout: 2000,
  });
});

// Using async within beforeEach is safe
beforeEach(async () => {
  const data = await loadTestData();
  // ...
});
```

**Testing Edge Cases:**
```typescript
it('should return empty array for unknown entry types', () => {
  const entry = {
    type: 'unknown',
    timestamp,
    message: { role: 'user', content: 'Should be ignored' },
  };
  const result = parseHistoryEntry(entry);
  expect(result).toHaveLength(0);
});

it('should handle empty content array', () => {
  const entry = {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [] },
  };
  const result = parseHistoryEntry(entry);
  expect(result).toHaveLength(0);
});

it('should use current timestamp if timestamp is missing', () => {
  const beforeTest = new Date().toISOString();
  const entry = {
    type: 'user',
    message: { role: 'user', content: 'No timestamp' },
  };
  const result = parseHistoryEntry(entry);
  expect(new Date(result[0].timestamp).getTime()).toBeGreaterThanOrEqual(
    new Date(beforeTest).getTime() - 1000
  );
});
```

**Testing Error Conditions:**
```typescript
it('should throw error after maxAttempts exhausted', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mockExec.mockResolvedValue({ stdout: '12345\n', stderr: '' });

  await expect(findAvailablePort(3000, 5)).rejects.toThrow(
    'Could not find an available port starting from 3000'
  );
});

it('should fall back to bind test when lsof fails', async () => {
  mockExec.mockRejectedValue(new Error('lsof: command not found'));
  mockServer.once.mockImplementation((event: string, callback: () => void) => {
    if (event === 'listening') {
      setTimeout(() => callback(), 0);
    }
    return mockServer;
  });

  const result = await isPortAvailable(3000);
  expect(result).toBe(true);
});
```

**Testing Conditional Logic:**
```typescript
// Test both branches
it('should parse text content as string when no array', () => {
  const entry = {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: 'Direct string response',
    },
  };
  const result = parseHistoryEntry(entry);
  expect(result[0].content).toBe('Direct string response');
});

it('should parse text content from array items', () => {
  const entry = {
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Hello from array!' }],
    },
  };
  const result = parseHistoryEntry(entry);
  expect(result[0].content).toBe('Hello from array!');
});
```

## Test Types in This Codebase

**Unit Tests:**
- Test individual functions and classes in isolation
- Mock all external dependencies
- Fast execution (< 1ms per test typically)
- Located in `.test.ts` files next to source
- Examples: `port.service.test.ts`, `session.test.ts`

**Integration Tests:**
- Not yet heavily used (noted in `vitest.config.ts` comment)
- Would test interactions between multiple modules
- May use real database or external services (or mocks of them)
- Future focus: Enable coverage thresholds as integration tests grow

**E2E Tests:**
- Not currently in use
- Would test full user workflows end-to-end

## Best Practices Observed

1. **Test isolation:** Each test is independent; can run in any order
2. **Clear naming:** Test names describe expected behavior and conditions
3. **Focused assertions:** Each test verifies one main behavior
4. **Setup/teardown discipline:** Clean state before/after each test
5. **Mock hoisting:** Mock imports before test file imports the module
6. **Conditional platform testing:** Override `process.platform` for cross-platform tests
7. **Callback simulation:** Use `setTimeout` in mocks to simulate async behavior
8. **Error classification:** Distinguish error types (SyntaxError vs operational)

---

*Testing analysis: 2026-02-01*
