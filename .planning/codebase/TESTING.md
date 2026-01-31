# Testing Patterns

**Analysis Date:** 2026-01-31

## Test Framework

**Runner:** Vitest (v4.0.18)
**Config:** `vitest.config.ts`

**Assertion Library:** Vitest built-in (Jest-compatible)
**Coverage Provider:** V8

**Run Commands:**
```bash
pnpm test              # Run all tests once
pnpm test:watch        # Run tests in watch mode
pnpm test:coverage     # Run tests with coverage report
```

## Test File Organization

**Location:** Co-located with source files using `.test.ts` suffix

**Pattern:**
```
src/
├── backend/
│   ├── claude/
│   │   ├── protocol.ts
│   │   ├── protocol.test.ts
│   │   ├── types.ts
│   │   └── types.test.ts
│   ├── services/
│   │   ├── scheduler.service.ts
│   │   └── scheduler.service.test.ts
│   └── trpc/
│       ├── workspace.trpc.ts
│       └── workspace.trpc.test.ts
├── components/
│   └── chat/
│       ├── chat-reducer.ts
│       └── chat-reducer.test.ts
└── hooks/
    ├── use-websocket-transport.ts
    └── use-websocket-transport.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Test Setup
// =============================================================================

describe('ComponentName', () => {
  let dependency: MockType;

  beforeEach(() => {
    vi.clearAllMocks();
    dependency = createMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Feature A Tests
  // -------------------------------------------------------------------------

  describe('featureA', () => {
    it('should do X when Y', () => {
      // Arrange
      const input = createTestInput();

      // Act
      const result = featureA(input);

      // Assert
      expect(result).toBe(expected);
    });

    it('should handle edge case Z', () => { ... });
  });

  // -------------------------------------------------------------------------
  // Feature B Tests
  // -------------------------------------------------------------------------

  describe('featureB', () => { ... });
});
```

**Section Dividers:** Use commented lines for visual organization
```typescript
// =============================================================================
// Test Helpers
// =============================================================================

// -------------------------------------------------------------------------
// sendUserMessage Tests
// -------------------------------------------------------------------------
```

## Test Setup

**Global Setup:** `src/backend/testing/setup.ts`
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

**Config (vitest.config.ts):**
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/backend/**/*.ts'],
      exclude: ['src/backend/**/*.test.ts', 'src/backend/index.ts', 'src/backend/testing/**'],
    },
    setupFiles: ['./src/backend/testing/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@prisma-gen': path.resolve(__dirname, './prisma/generated'),
    },
  },
});
```

## Mocking

**Framework:** Vitest built-in (`vi`)

**Module Mocking Pattern:**
```typescript
// Mock dependencies BEFORE importing the module under test
const mockFindNeedingPRSync = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findNeedingPRSync: () => mockFindNeedingPRSync(),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER mocks are set up
import { schedulerService } from './scheduler.service';
```

**Function Spy Pattern:**
```typescript
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
  // Intentionally empty - suppress console output during test
});

// After test
consoleErrorSpy.mockRestore();
```

**Mock Implementation with Tracking:**
```typescript
let currentConcurrent = 0;
let maxConcurrent = 0;

mockFetchAndComputePRState.mockImplementation(async () => {
  currentConcurrent++;
  maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
  await new Promise((resolve) => setTimeout(resolve, 10));
  currentConcurrent--;
  return { prNumber: 1, prState: 'OPEN', prReviewState: null, prCiStatus: 'PENDING' };
});
```

**What to Mock:**
- External services (GitHub CLI, logger)
- Database accessors
- File system operations
- Network requests

**What NOT to Mock:**
- The module under test
- Pure utility functions
- Type definitions

## Fixtures and Factories

**Test Data Factories:**
```typescript
function createTestToolUseMessage(toolUseId: string): ClaudeMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseId,
        name: 'TestTool',
        input: { arg: 'value' },
      },
    },
  };
}

function createTestAssistantMessage(): ClaudeMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    },
  };
}
```

**State Factories:**
```typescript
function createInitialChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    messages: [],
    sessionStatus: { phase: 'idle' },
    gitBranch: null,
    availableSessions: [],
    pendingRequest: { type: 'none' },
    chatSettings: DEFAULT_CHAT_SETTINGS,
    queuedMessages: new Map(),
    toolUseIdToIndex: new Map(),
    ...overrides,
  };
}
```

**Helper Conversion Functions:**
```typescript
function toQueuedMessagesMap(messages: QueuedMessage[]): Map<string, QueuedMessage> {
  const map = new Map<string, QueuedMessage>();
  for (const msg of messages) {
    map.set(msg.id, msg);
  }
  return map;
}
```

## Coverage

**Requirements:** No enforced thresholds (disabled in config)

**Coverage is collected for:**
- `src/backend/**/*.ts`

**Excluded from coverage:**
- Test files (`*.test.ts`)
- Entry points (`src/backend/index.ts`)
- Test utilities (`src/backend/testing/**`)

**View Coverage:**
```bash
pnpm test:coverage
# Reports output to: coverage/
# - text (terminal)
# - html (coverage/index.html)
# - json-summary (coverage/coverage-summary.json)
```

## Test Types

**Unit Tests:**
- Test individual functions and classes in isolation
- Mock all external dependencies
- Location: co-located with source files

**Integration Tests:**
- Test multiple components working together
- Use real implementations where practical
- Mock only external services (DB, network)

**Frontend Component Tests:**
- Not widely implemented yet
- Storybook used for visual component testing
- Stories location: co-located with components (`.stories.tsx`)

## Common Patterns

**Async Testing:**
```typescript
it('should resolve with response data when CLI responds', async () => {
  const initPromise = protocol.sendInitialize();

  // Wait a tick for the message to be sent
  await new Promise((resolve) => setImmediate(resolve));

  // Send the response
  stdout.write(`${JSON.stringify(response)}\n`);

  const result = await initPromise;
  expect(result).toEqual(responseData);
});
```

**Error Testing:**
```typescript
it('should reject on timeout', async () => {
  const shortTimeoutProtocol = new ClaudeProtocol(stdin, stdout, { requestTimeout: 50 });
  shortTimeoutProtocol.start();

  await expect(shortTimeoutProtocol.sendInitialize()).rejects.toThrow('timed out');

  shortTimeoutProtocol.stop();
});
```

**Timer Testing:**
```typescript
describe('interval behavior', () => {
  it('should run sync every 5 minutes when started', async () => {
    vi.useFakeTimers();
    mockFindNeedingPRSync.mockResolvedValue([]);

    schedulerService.start();
    expect(mockFindNeedingPRSync).not.toHaveBeenCalled();

    // First interval tick (5 minutes)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(1);

    await schedulerService.stop();
    vi.useRealTimers();
  });
});
```

**Stream/Event Testing:**
```typescript
it('should emit message event for valid JSON', async () => {
  const messagePromise = new Promise<ClaudeJson>((resolve) => {
    protocol.on('message', resolve);
  });

  const msg: AssistantMessage = {
    type: 'assistant',
    session_id: 'abc',
    message: { role: 'assistant', content: [] },
  };
  stdout.write(`${JSON.stringify(msg)}\n`);

  const received = await messagePromise;
  expect(received).toEqual(msg);
});
```

**State Transition Testing (Reducer):**
```typescript
describe('WS_STATUS action', () => {
  it('should set sessionStatus to running when payload.running is true', () => {
    const action: ChatAction = { type: 'WS_STATUS', payload: { running: true } };
    const newState = chatReducer(initialState, action);

    expect(newState.sessionStatus).toEqual({ phase: 'running' });
  });
});
```

**Testing Race Conditions:**
```typescript
it('should preserve existing pendingPermission when session_loaded has no pending request (race condition)', () => {
  const existingPermission: PermissionRequest = { ... };
  const state: ChatState = {
    ...initialState,
    pendingRequest: { type: 'permission', request: existingPermission },
    sessionStatus: { phase: 'loading' } as const,
  };

  const action: ChatAction = {
    type: 'WS_SESSION_LOADED',
    payload: {
      messages: [],
      gitBranch: 'main',
      running: true,
      pendingInteractiveRequest: null, // No pending request from backend
    },
  };
  const newState = chatReducer(state, action);

  // Should preserve the existing permission, not overwrite with null
  expect(newState.pendingRequest).toEqual({ type: 'permission', request: existingPermission });
});
```

## Storybook

**Used for:** Visual component documentation and testing
**Port:** 6006

**Run:**
```bash
pnpm storybook
```

**Story Pattern:**
```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './button';

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: ['default', 'destructive', ...] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: 'Button' },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex gap-4">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
    </div>
  ),
};
```

---

*Testing analysis: 2026-01-31*
