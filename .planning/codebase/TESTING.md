# Testing Patterns

**Analysis Date:** 2026-02-09

## Test Framework

**Runner:**
- Vitest v4.0.18
- Config: `vitest.config.ts`
- Node environment only (no browser testing in main suite)
- Globals enabled: `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi` are available without imports

**Assertion Library:**
- Vitest built-in expect/assertions (Vitest includes `chai` matchers)

**Run Commands:**
```bash
pnpm test              # Run all tests once
pnpm test:watch       # Watch mode for development
pnpm test:coverage    # Generate coverage report (HTML + JSON)
```

**Coverage:**
- Provider: v8
- Reporters: text, json, json-summary, html
- Scope: `src/backend/**/*.ts` only (frontend tests excluded from coverage)
- Excludes: `*.test.ts`, `index.ts`, `src/backend/testing/**`
- Thresholds: disabled (can be enabled as integration test coverage grows)
- View coverage: run `pnpm test:coverage`, view HTML report in `coverage/`

## Test File Organization

**Location:**
- Co-located with source files (same directory)
- Example: `src/backend/clients/git.client.ts` → `src/backend/clients/git.client.test.ts`

**Naming:**
- `{module}.test.ts` for unit tests
- `{module}.test.tsx` for React component tests

**Structure:**
```
src/backend/
├── clients/
│   ├── git.client.ts
│   └── git.client.test.ts
├── services/
│   ├── logger.service.ts
│   └── (no test - system service)
└── resource_accessors/
    ├── project.accessor.ts
    └── project.accessor.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

**Patterns:**
- Use nested `describe()` blocks to organize related tests
- Use `beforeEach()` to set up test fixtures (shared state)
- Use `afterEach()` to clean up mocks and state
- Use simple, descriptive test names starting with `it('should ...')`
- Arrange-Act-Assert pattern within each test
- Add section comments for logical test groups:
  ```typescript
  // ===========================================================================
  // Constructor Tests
  // ===========================================================================
  ```

**Setup:**
- Global setup file: `src/backend/testing/setup.ts`
- Runs before all tests
- Clears and restores all mocks:
  ```typescript
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  ```

**Teardown:**
- `afterEach()` for test-specific cleanup
- Global `afterEach()` in setup file restores all mocks

## Mocking

**Framework:** Vitest's built-in `vi` module

**Module Mocking Pattern:**
```typescript
// Mock BEFORE importing the module under test
const mockQueryRaw = vi.fn();
const mockGetEnvironment = vi.fn();

vi.mock('../../resource_accessors/health.accessor', () => ({
  healthAccessor: {
    checkDatabaseConnection: () => mockQueryRaw(),
  },
}));

// Import AFTER mocks are defined
import { createHealthRouter } from './health.router';

describe('healthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set default mock returns
    mockGetEnvironment.mockReturnValue('development');
    mockQueryRaw.mockResolvedValue([{ '1': 1 }]);
  });

  it('tests the mocked module', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });
});
```

**Spy Pattern:**
```typescript
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

try {
  // Code that might call console.error
} finally {
  // Spy is automatically restored in afterEach from setup.ts
}
```

**Mock Return Values:**
- Use `.mockReturnValue()` for sync functions: `fn.mockReturnValue(value)`
- Use `.mockResolvedValue()` for async functions: `fn.mockResolvedValue(value)`
- Use `.mockImplementation()` for custom behavior: `fn.mockImplementation((arg) => ...)`
- Use `.mockRejectedValue()` for Promise rejections: `fn.mockRejectedValue(error)`

**What to Mock:**
- External dependencies (databases, APIs, file system)
- Imported modules (services, accessors, utilities)
- Browser APIs (`localStorage`, `fetch`, etc.)
- Time functions when testing timing-dependent code

**What NOT to Mock:**
- Functions under test (the system being tested)
- Pure utility functions without side effects
- Zod schemas and type validators (test real validation)
- Error constructors and error types
- Constants and configuration

## Fixtures and Factories

**Test Data:**
```typescript
// Inline fixtures
const testConfig = {
  baseRepoPath: '/test/repo',
  worktreeBase: '/test/worktrees',
};

// Factory functions
function createMockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    path: '/api/test',
    headers: {},
    ...overrides,
  } as Request;
}

// Using unsafe coercion for complex mocks
const appContext = unsafeCoerce<AppContext>({
  services: {
    configService: { getEnvironment: () => 'development' },
    createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
  },
});
```

**Location:**
- Simple fixtures: inline in test file (describe block or beforeEach)
- Complex fixtures: `src/backend/testing/` directory (shared across tests)
- Helper utilities: `src/test-utils/` directory (e.g., `unsafe-coerce.ts`)

**Unsafe Coerce Utility:**
- File: `src/test-utils/unsafe-coerce.ts`
- Purpose: Type-cast partial mocks to their full types
- Usage: `unsafeCoerce<FullType>(partialMock)` when mocking complex objects
- Use sparingly; only when partial mocking is necessary

## Coverage

**Requirements:** None enforced (thresholds disabled)

**View Coverage:**
```bash
pnpm test:coverage
# Open coverage/index.html in browser
```

**Scope:**
- Includes: `src/backend/**/*.ts`
- Excludes: test files, index.ts, testing utilities

**Strategy:**
- Focus on critical business logic and error paths
- Unit tests use mocks (high coverage, fast)
- Integration tests planned for higher confidence as coverage grows
- End-to-end tests use Playwright (run separately, not in vitest)

## Test Types

**Unit Tests:**
- Scope: Single function or class method
- Approach: Mock external dependencies, test logic in isolation
- Example: `GitClient.getWorktreePath()` tests path construction
- Should run in < 10ms each
- File location: co-located with source

**Integration Tests:**
- Not yet extensive (vitest configured for basics)
- Approach: Test interactions between multiple modules
- Example: Full workflow from request to database
- Would use test database (not yet set up)

**E2E Tests:**
- Framework: Playwright (not part of vitest suite)
- Run separately from vitest
- Test full user workflows through the app
- Manual setup required; not in automated test suite yet

## Common Patterns

**Async Testing:**
```typescript
it('should handle async operations', async () => {
  const result = await client.createWorktree('test-workspace');
  expect(result).toBeDefined();
  expect(result.path).toContain('test-workspace');
});
```

**Error Testing:**
```typescript
it('should throw on invalid config', () => {
  expect(() => new GitClient({ baseRepoPath: '', worktreeBase: '/test' })).toThrow(
    'baseRepoPath is required'
  );
});

it('should reject on failed operation', async () => {
  mockCommand.mockRejectedValue(new Error('Command failed'));
  await expect(client.doSomething()).rejects.toThrow('Command failed');
});
```

**Multiple Files Testing:**
```typescript
describe('multiple files', () => {
  it('should parse multiple files correctly', () => {
    const output = ' M README.md\nM  package.json\n?? newfile.txt\n';
    const result = parseGitStatusOutput(output);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      path: 'README.md',
      status: 'M',
      staged: false,
    });
    expect(result[1]).toEqual({
      path: 'package.json',
      status: 'M',
      staged: true,
    });
  });
});
```

**Schema Validation Testing:**
```typescript
describe('ExitPlanModeInputSchema', () => {
  it('accepts inline plan content (SDK format)', () => {
    const input = {
      plan: '# My Plan\n\n## Steps\n1. Do this\n2. Do that',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan).toBe('# My Plan\n\n## Steps\n1. Do this\n2. Do that');
    }
  });

  it('rejects invalid structure', () => {
    const input = { invalidKey: 'value' };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
```

**HTTP Testing with supertest:**
```typescript
import express from 'express';
import request from 'supertest';

describe('healthRouter', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use('/health', createHealthRouter(appContext));
  });

  it('returns status ok', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});
```

**Mock Express Middleware:**
```typescript
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
    sendStatus: vi.fn(),
  };
}

describe('middleware', () => {
  it('sets security headers', () => {
    const req = createMockReq();
    const res = createMockRes() as Response;
    const next = vi.fn() as NextFunction;

    securityMiddleware(req, res, next);
    expect(res.header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });
});
```

---

*Testing analysis: 2026-02-09*
