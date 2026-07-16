# WebSocket Stream Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound queued WebSocket data for high-volume terminal and log output and log asynchronous send failures.

**Architecture:** Extend the existing `websocket-send` utility with a stream-specific sender that drops output when the current `bufferedAmount` plus the UTF-8 message size would exceed 1 MiB, and tracks per-socket congestion warnings in a `WeakSet`. Route only live output callbacks through this helper; leave replay and low-volume control messages on their existing paths.

**Tech Stack:** TypeScript, `ws`, Vitest, Express WebSocket handlers

## Global Constraints

- Apply backpressure only to live workspace-terminal, setup-terminal, dev-log, and post-run-log output.
- Use a fixed 1 MiB threshold and drop chunks when `ws.bufferedAmount + Buffer.byteLength(message)` is greater than the threshold.
- Emit at most one warning per socket congestion window and resume sends when the current buffer has enough capacity for the next message.
- Use the `ws.send` callback to log asynchronous send failures.
- Do not add an application-level output queue or pause shared PTYs.
- Do not introduce `TopicBroadcaster` or change the browser WebSocket protocol.
- Keep replay payloads and low-volume create, exit, and error messages unchanged.

---

### Task 1: Add the stream-aware WebSocket send primitive

**Files:**
- Modify: `src/backend/lib/websocket-send.ts`
- Test: `src/backend/lib/websocket-send.test.ts`

**Interfaces:**
- Consumes: `WebSocket.readyState`, `WebSocket.bufferedAmount`, `WebSocket.send(data, callback)` from `ws`, and `Buffer.byteLength(message)` for UTF-8 payload size
- Produces: `MAX_WEBSOCKET_STREAM_BUFFERED_BYTES: number` and `sendStreamOutput(ws, message, logger, description?): boolean`

- [ ] **Step 1: Add failing tests for threshold, recovery, and send errors**

Update the test imports and mock:

```ts
import {
  MAX_WEBSOCKET_STREAM_BUFFERED_BYTES,
  safeSend,
  sendStreamOutput,
} from './websocket-send';

function createMockWs(
  readyState: number = WS_READY_STATE.OPEN,
  bufferedAmount = 0
) {
  return {
    readyState,
    bufferedAmount,
    send: vi.fn(),
  };
}

function createMockLogger() {
  return { error: vi.fn(), warn: vi.fn() };
}
```

Add these tests:

```ts
describe('sendStreamOutput', () => {
  it('sends stream output when the projected buffer is at the threshold', () => {
    const message = 'output';
    const ws = createMockWs(
      WS_READY_STATE.OPEN,
      MAX_WEBSOCKET_STREAM_BUFFERED_BYTES - Buffer.byteLength(message)
    );
    const logger = createMockLogger();

    expect(
      sendStreamOutput(
        ws as unknown as WebSocket,
        message,
        logger,
        'terminal output'
      )
    ).toBe(true);

    expect(ws.send).toHaveBeenCalledWith(message, expect.any(Function));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops output when its UTF-8 bytes would push the buffer above the threshold', () => {
    const message = 'éé';
    const ws = createMockWs(
      WS_READY_STATE.OPEN,
      MAX_WEBSOCKET_STREAM_BUFFERED_BYTES - Buffer.byteLength(message) + 1
    );
    const logger = createMockLogger();

    expect(
      sendStreamOutput(ws as unknown as WebSocket, message, logger, 'log output')
    ).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('drops output and warns once while a socket remains congested', () => {
    const ws = createMockWs(
      WS_READY_STATE.OPEN,
      MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1
    );
    const logger = createMockLogger();

    expect(
      sendStreamOutput(ws as unknown as WebSocket, 'first', logger, 'log output')
    ).toBe(false);
    expect(
      sendStreamOutput(ws as unknown as WebSocket, 'second', logger, 'log output')
    ).toBe(false);

    expect(ws.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropping log output because WebSocket send buffer is congested',
      {
        bufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1,
        maxBufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES,
      }
    );
  });

  it('resumes output and allows a new warning after the socket drains', () => {
    const ws = createMockWs(
      WS_READY_STATE.OPEN,
      MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1
    );
    const logger = createMockLogger();

    sendStreamOutput(ws as unknown as WebSocket, 'dropped', logger);
    ws.bufferedAmount =
      MAX_WEBSOCKET_STREAM_BUFFERED_BYTES - Buffer.byteLength('resumed');
    expect(
      sendStreamOutput(ws as unknown as WebSocket, 'resumed', logger)
    ).toBe(true);

    ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
    expect(
      sendStreamOutput(ws as unknown as WebSocket, 'dropped again', logger)
    ).toBe(false);

    expect(ws.send).toHaveBeenCalledWith('resumed', expect.any(Function));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs asynchronous send callback errors', () => {
    const ws = createMockWs();
    ws.send.mockImplementation(
      (_message: string, callback: (error?: Error) => void) => {
        callback(new Error('write failed'));
      }
    );
    const logger = createMockLogger();

    expect(
      sendStreamOutput(
        ws as unknown as WebSocket,
        'output',
        logger,
        'terminal output'
      )
    ).toBe(true);

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to send terminal output',
      expect.objectContaining({ message: 'write failed' })
    );
  });

  it('catches synchronous stream send errors and ignores closed sockets', () => {
    const throwingWs = createMockWs();
    throwingWs.send.mockImplementation(() => {
      throw new Error('socket closing');
    });
    const logger = createMockLogger();

    expect(
      sendStreamOutput(
        throwingWs as unknown as WebSocket,
        'output',
        logger,
        'terminal output'
      )
    ).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to send terminal output',
      expect.objectContaining({ message: 'socket closing' })
    );

    const closedWs = createMockWs(WS_READY_STATE.CLOSED);
    expect(
      sendStreamOutput(closedWs as unknown as WebSocket, 'output', logger)
    ).toBe(false);
    expect(closedWs.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the utility test and verify it fails for the missing API**

Run:

```bash
pnpm vitest run src/backend/lib/websocket-send.test.ts
```

Expected: FAIL because `MAX_WEBSOCKET_STREAM_BUFFERED_BYTES` and `sendStreamOutput` are not exported.

- [ ] **Step 3: Implement the minimal stream sender**

Add the stream logger, constant, state, and function to `websocket-send.ts`:

```ts
interface StreamSendLogger extends SendErrorLogger {
  warn(message: string, data: Record<string, unknown>): void;
}

export const MAX_WEBSOCKET_STREAM_BUFFERED_BYTES = 1024 * 1024;

const congestedStreamSockets = new WeakSet<WebSocket>();

export function sendStreamOutput(
  ws: WebSocket,
  message: string,
  logger: StreamSendLogger,
  description = 'WebSocket stream output'
): boolean {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    return false;
  }

  if (
    ws.bufferedAmount + Buffer.byteLength(message) >
    MAX_WEBSOCKET_STREAM_BUFFERED_BYTES
  ) {
    if (!congestedStreamSockets.has(ws)) {
      congestedStreamSockets.add(ws);
      logger.warn(`Dropping ${description} because WebSocket send buffer is congested`, {
        bufferedAmount: ws.bufferedAmount,
        maxBufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES,
      });
    }
    return false;
  }

  congestedStreamSockets.delete(ws);

  try {
    ws.send(message, (error) => {
      if (error) {
        logger.error(`Failed to send ${description}`, toError(error));
      }
    });
    return true;
  } catch (error) {
    logger.error(`Failed to send ${description}`, toError(error));
    return false;
  }
}
```

- [ ] **Step 4: Run the utility test and verify it passes**

Run:

```bash
pnpm vitest run src/backend/lib/websocket-send.test.ts
```

Expected: PASS with all `safeSend` and `sendStreamOutput` tests green.

- [ ] **Step 5: Commit the primitive**

```bash
git add src/backend/lib/websocket-send.ts src/backend/lib/websocket-send.test.ts
git commit -m "Add WebSocket stream backpressure helper"
```

### Task 2: Route high-volume handler output through the primitive

**Files:**
- Modify: `src/backend/routers/websocket/push-channel.handler.ts`
- Modify: `src/backend/routers/websocket/terminal.handler.ts`
- Modify: `src/backend/routers/websocket/setup-terminal.handler.ts`
- Test: `src/backend/routers/websocket/dev-logs.handler.test.ts`
- Test: `src/backend/routers/websocket/terminal.handler.test.ts`
- Test: `src/backend/routers/websocket/setup-terminal.handler.test.ts`

**Interfaces:**
- Consumes: `sendStreamOutput(ws, serializedOutput, logger, description)` from Task 1
- Produces: bounded live output sends for both shared log channels, workspace terminals, and setup terminals

- [ ] **Step 1: Add `bufferedAmount` to handler WebSocket mocks**

Add this property to each `MockWebSocket` class in the three handler test files:

```ts
bufferedAmount = 0;
```

- [ ] **Step 2: Add a failing shared push-channel regression test**

Import the threshold in `dev-logs.handler.test.ts`:

```ts
import { MAX_WEBSOCKET_STREAM_BUFFERED_BYTES } from '@/backend/lib/websocket-send';
```

Extend `streams buffered and live output only while socket is open` after obtaining `outputSubscriber`:

```ts
ws.send.mockClear();
ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
outputSubscriber('dropped logs\n');
expect(ws.send).not.toHaveBeenCalled();

ws.bufferedAmount = 0;
outputSubscriber('resumed logs\n');
expect(ws.send).toHaveBeenCalledWith(
  JSON.stringify({ type: 'output', data: 'resumed logs\n' }),
  expect.any(Function)
);
```

- [ ] **Step 3: Add a failing workspace-terminal regression test**

Import the threshold in `terminal.handler.test.ts`:

```ts
import { MAX_WEBSOCKET_STREAM_BUFFERED_BYTES } from '@/backend/lib/websocket-send';
```

Add:

```ts
it('drops live terminal output while the socket is congested and resumes after drain', async () => {
  const workspaceId = 'workspace-1';
  const terminalId = 'terminal-1';
  const { terminalService, outputListeners } = createTerminalService();
  terminalService.getTerminalsForWorkspace.mockReturnValue([
    {
      id: terminalId,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      outputBuffer: '',
    },
  ]);
  const logger = createLogger();
  const appContext = {
    services: {
      terminalService,
      configService: {
        getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
      },
      createLogger: vi.fn(() => logger),
    },
  } as unknown as AppContext;
  const ws = new MockWebSocket();
  const handler = createTerminalUpgradeHandler(appContext);

  handler(
    createRequest(),
    { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
    Buffer.alloc(0),
    new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
    createWss(ws),
    new WeakMap<WebSocket, boolean>()
  );

  await vi.waitFor(() => {
    expect(outputListeners.get(terminalId)?.size).toBe(1);
  });
  const listener = Array.from(outputListeners.get(terminalId) ?? [])[0];
  if (!listener) {
    throw new Error('Expected terminal output listener');
  }

  ws.send.mockClear();
  ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
  listener('dropped output');
  expect(ws.send).not.toHaveBeenCalled();

  ws.bufferedAmount = 0;
  listener('resumed output');
  expect(ws.send).toHaveBeenCalledWith(
    JSON.stringify({
      type: 'output',
      terminalId,
      data: 'resumed output',
    }),
    expect.any(Function)
  );
});
```

- [ ] **Step 4: Add a failing setup-terminal regression assertion**

Import the threshold in `setup-terminal.handler.test.ts`:

```ts
import { MAX_WEBSOCKET_STREAM_BUFFERED_BYTES } from '@/backend/lib/websocket-send';
```

In the existing creation/routing test, replace the immediate `onDataCallback` assertion with:

```ts
ws.send.mockClear();
ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
onDataCallback?.('dropped shell output');
expect(ws.send).not.toHaveBeenCalled();

ws.bufferedAmount = 0;
onDataCallback?.('hello from shell');
expect(ws.send).toHaveBeenCalledWith(
  JSON.stringify({ type: 'output', data: 'hello from shell' }),
  expect.any(Function)
);
```

- [ ] **Step 5: Run the handler tests and verify they fail because output still bypasses the helper**

Run:

```bash
pnpm vitest run \
  src/backend/routers/websocket/dev-logs.handler.test.ts \
  src/backend/routers/websocket/terminal.handler.test.ts \
  src/backend/routers/websocket/setup-terminal.handler.test.ts
```

Expected: FAIL because congested live output is still sent.

- [ ] **Step 6: Route live log output through the helper**

Change the import in `push-channel.handler.ts`:

```ts
import { safeSend, sendStreamOutput } from '@/backend/lib/websocket-send';
```

Change only the live subscription:

```ts
const unsubscribe = subscribeToOutput(workspaceId, (data) => {
  sendStreamOutput(
    ws,
    JSON.stringify({ type: 'output', data }),
    logger,
    'log output'
  );
});
```

Keep the initial output-buffer replay on `safeSend`.

- [ ] **Step 7: Route live workspace-terminal output through the helper**

Add:

```ts
import { sendStreamOutput } from '@/backend/lib/websocket-send';
```

Replace the output listener body with:

```ts
const unsubOutput = terminalService.onOutput(terminalId, (output) => {
  sendStreamOutput(
    ws,
    JSON.stringify({ type: 'output', terminalId, data: output }),
    logger,
    'terminal output'
  );
});
```

Keep the exit path unchanged.

- [ ] **Step 8: Route live setup-terminal output through the helper**

Add:

```ts
import { sendStreamOutput } from '@/backend/lib/websocket-send';
```

Replace the PTY data callback body with:

```ts
state.pty.onData((output: string) => {
  sendStreamOutput(
    ws,
    JSON.stringify({ type: 'output', data: output }),
    logger,
    'setup terminal output'
  );
});
```

Keep create and exit messages unchanged.

- [ ] **Step 9: Update existing live-output call-shape assertions**

Any existing assertion for live terminal, setup-terminal, dev-log, or post-run-log output must expect the callback argument:

```ts
expect(ws.send).toHaveBeenCalledWith(
  JSON.stringify({ type: 'output', data: expectedData }),
  expect.any(Function)
);
```

Replay payloads and control-message assertions must continue expecting one argument.

- [ ] **Step 10: Run all affected WebSocket tests**

Run:

```bash
pnpm vitest run \
  src/backend/lib/websocket-send.test.ts \
  src/backend/routers/websocket/dev-logs.handler.test.ts \
  src/backend/routers/websocket/post-run-logs.handler.test.ts \
  src/backend/routers/websocket/terminal.handler.test.ts \
  src/backend/routers/websocket/setup-terminal.handler.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit the handler integration**

```bash
git add \
  src/backend/routers/websocket/push-channel.handler.ts \
  src/backend/routers/websocket/terminal.handler.ts \
  src/backend/routers/websocket/setup-terminal.handler.ts \
  src/backend/routers/websocket/dev-logs.handler.test.ts \
  src/backend/routers/websocket/post-run-logs.handler.test.ts \
  src/backend/routers/websocket/terminal.handler.test.ts \
  src/backend/routers/websocket/setup-terminal.handler.test.ts
git commit -m "Bound high-volume WebSocket output buffering"
```

### Task 3: Verify repository guardrails

**Files:**
- Verify: all changed files

**Interfaces:**
- Consumes: completed Tasks 1 and 2
- Produces: evidence that the issue is fixed without type, lint, boundary, or test regressions

- [ ] **Step 1: Run formatting and apply any mechanical changes**

Run:

```bash
pnpm check:fix
```

Expected: exit 0. If files change, inspect and commit only formatting changes related to this issue.

- [ ] **Step 2: Run TypeScript checks**

Run:

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run repository checks**

Run:

```bash
pnpm check
```

Expected: exit 0.

- [ ] **Step 4: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: exit 0 with no failing Vitest files.

- [ ] **Step 5: Inspect the final diff and worktree**

Run:

```bash
git diff --check
git status --short
git log --oneline -3
```

Expected: no whitespace errors; only intentional issue files are modified or committed.
