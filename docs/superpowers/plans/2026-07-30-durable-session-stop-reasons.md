# Durable Session Stop Reasons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every interrupted turn and stopped session as an explanatory chat-log entry, and raise the normal user-turn timeout from one hour to four hours.

**Architecture:** The session capsule owns an append-only `SessionLifecycleEvent` table and a focused service that persists, deduplicates, hydrates, and live-publishes structured lifecycle messages. Provider history remains authoritative for provider messages; lifecycle messages are mapped to stable chat-message IDs and merged into that history by timestamp whenever a session loads or a transcript is saved. Prompt, explicit-stop, workspace-archive, and unexpected-exit paths supply typed reasons and caller-stable dedupe keys.

**Tech Stack:** TypeScript, Prisma/SQLite, Express/tRPC, ACP, WebSocket session deltas, React, Vitest, Testing Library, Biome, pnpm.

## Global Constraints

- The standard user prompt deadline is exactly `4 * 60 * 60 * 1000` (`14_400_000`) milliseconds.
- Auto-iteration's configurable prompt timeout, tool-call timeouts, shutdown waits, queue waits, and ratchet scheduling do not change.
- Lifecycle events are append-only and survive `AgentSession` deletion; only deleting the owning `Workspace` cascades them.
- `[sessionId, dedupeKey]` is unique, with indexes on `[sessionId, createdAt]` and `workspaceId`.
- Provider transcript files are never modified.
- Database persistence is attempted before live lifecycle-message emission.
- Provider error text is whitespace-normalized, stripped of unsafe detail, and bounded to 240 characters before persistence.
- Hydration failures are logged and do not block provider history or session usability.
- Lifecycle messages use stable IDs, merge chronologically, and remain idempotent through reconnects and Codex history backfills.
- Prompt timeout, user stop, session close, workspace archive, and system stop render with neutral/warning styling; provider failure and unexpected exit render with error styling.
- Existing service-capsule and client feature import boundaries remain intact.

---

### Task 1: Add the durable lifecycle-event data contract

**Files:**

- Modify: `prisma/schema.prisma` next to `AgentSession` and the `Workspace` relations
- Create: `prisma/migrations/20260730140000_add_session_lifecycle_events/migration.sql`
- Modify: `src/shared/core/enums.ts`
- Modify: `src/shared/core/index.ts`
- Modify: `src/backend/services/registry.ts`
- Create: `src/backend/services/session/resources/session-lifecycle-event.accessor.ts`
- Create: `src/backend/services/session/resources/session-lifecycle-event.accessor.test.ts`

**Interfaces:**

- Consumes: the existing `prisma` client and session-capsule resource pattern.
- Produces:

```ts
export const SessionLifecycleEventKind = {
  TURN_INTERRUPTED: 'TURN_INTERRUPTED',
  SESSION_STOPPED: 'SESSION_STOPPED',
} as const;
export type SessionLifecycleEventKind =
  (typeof SessionLifecycleEventKind)[keyof typeof SessionLifecycleEventKind];

export const SessionLifecycleEventReason = {
  PROMPT_TIMEOUT: 'PROMPT_TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  USER_STOP: 'USER_STOP',
  SESSION_CLOSED: 'SESSION_CLOSED',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  UNEXPECTED_EXIT: 'UNEXPECTED_EXIT',
  SYSTEM_STOP: 'SYSTEM_STOP',
} as const;
export type SessionLifecycleEventReason =
  (typeof SessionLifecycleEventReason)[keyof typeof SessionLifecycleEventReason];

export interface UpsertSessionLifecycleEventInput {
  workspaceId: string;
  sessionId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  dedupeKey: string;
  createdAt: Date;
}

export interface SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord>;
  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]>;
}
```

- [ ] **Step 1: Write the accessor tests**

Create `session-lifecycle-event.accessor.test.ts` with a hoisted Prisma mock and these assertions:

```ts
it('upserts by the compound session and dedupe key', async () => {
  const createdAt = new Date('2026-07-30T12:22:23.353Z');
  vi.mocked(prisma.sessionLifecycleEvent.upsert).mockResolvedValue(eventRecord);

  await sessionLifecycleEventAccessor.upsert({
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    kind: SessionLifecycleEventKind.TURN_INTERRUPTED,
    reason: SessionLifecycleEventReason.PROMPT_TIMEOUT,
    message: 'Turn stopped: reached the 4-hour limit.',
    dedupeKey: 'turn:attempt-1:stop',
    createdAt,
  });

  expect(prisma.sessionLifecycleEvent.upsert).toHaveBeenCalledWith({
    where: {
      sessionId_dedupeKey: {
        sessionId: 'session-1',
        dedupeKey: 'turn:attempt-1:stop',
      },
    },
    create: {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      kind: 'TURN_INTERRUPTED',
      reason: 'PROMPT_TIMEOUT',
      message: 'Turn stopped: reached the 4-hour limit.',
      dedupeKey: 'turn:attempt-1:stop',
      createdAt,
    },
    update: {},
  });
});

it('loads events in chronological and id order', async () => {
  vi.mocked(prisma.sessionLifecycleEvent.findMany).mockResolvedValue([]);

  await sessionLifecycleEventAccessor.findBySessionId('session-1');

  expect(prisma.sessionLifecycleEvent.findMany).toHaveBeenCalledWith({
    where: { sessionId: 'session-1' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
});
```

- [ ] **Step 2: Run the new test and confirm the missing accessor**

Run:

```bash
pnpm vitest run src/backend/services/session/resources/session-lifecycle-event.accessor.test.ts
```

Expected: FAIL because the accessor and generated Prisma model do not exist.

- [ ] **Step 3: Add schema enums, relation, model, and SQL migration**

Add the Prisma enums and model:

```prisma
enum SessionLifecycleEventKind {
  TURN_INTERRUPTED
  SESSION_STOPPED
}

enum SessionLifecycleEventReason {
  PROMPT_TIMEOUT
  PROVIDER_ERROR
  USER_STOP
  SESSION_CLOSED
  WORKSPACE_ARCHIVED
  UNEXPECTED_EXIT
  SYSTEM_STOP
}

model SessionLifecycleEvent {
  id          String                      @id @default(cuid())
  workspaceId String
  workspace   Workspace                   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  sessionId   String
  kind        SessionLifecycleEventKind
  reason      SessionLifecycleEventReason
  message     String
  dedupeKey   String
  createdAt   DateTime                    @default(now())

  @@unique([sessionId, dedupeKey])
  @@index([sessionId, createdAt])
  @@index([workspaceId])
}
```

Add `sessionLifecycleEvents SessionLifecycleEvent[]` to `Workspace`. Create the SQLite migration:

```sql
CREATE TABLE "SessionLifecycleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionLifecycleEvent_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SessionLifecycleEvent_sessionId_dedupeKey_key"
  ON "SessionLifecycleEvent"("sessionId", "dedupeKey");
CREATE INDEX "SessionLifecycleEvent_sessionId_createdAt_idx"
  ON "SessionLifecycleEvent"("sessionId", "createdAt");
CREATE INDEX "SessionLifecycleEvent_workspaceId_idx"
  ON "SessionLifecycleEvent"("workspaceId");
```

- [ ] **Step 4: Add shared enum mirrors and service ownership**

Export the two const/type pairs shown in the Interfaces block from `enums.ts` and `core/index.ts`. Add `SessionLifecycleEvent` to `prismaModelNames` and to the session service's `ownsModels` array.

- [ ] **Step 5: Generate Prisma and implement the resource accessor**

Run:

```bash
pnpm db:generate
```

Implement:

```ts
import type { SessionLifecycleEvent } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type {
  SessionLifecycleEventKind,
  SessionLifecycleEventReason,
} from '@/shared/core';

export type SessionLifecycleEventRecord = SessionLifecycleEvent;

export interface UpsertSessionLifecycleEventInput {
  workspaceId: string;
  sessionId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  dedupeKey: string;
  createdAt: Date;
}

export interface SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord>;
  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]>;
}

class PrismaSessionLifecycleEventAccessor implements SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord> {
    return prisma.sessionLifecycleEvent.upsert({
      where: {
        sessionId_dedupeKey: {
          sessionId: input.sessionId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: input,
      update: {},
    });
  }

  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]> {
    return prisma.sessionLifecycleEvent.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}

export const sessionLifecycleEventAccessor = new PrismaSessionLifecycleEventAccessor();
```

- [ ] **Step 6: Verify schema and accessor**

Run:

```bash
pnpm vitest run src/backend/services/session/resources/session-lifecycle-event.accessor.test.ts
pnpm check:prisma-schema
pnpm check:service-registry
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the persistence contract**

```bash
git add prisma/schema.prisma prisma/migrations/20260730140000_add_session_lifecycle_events/migration.sql prisma/generated src/shared/core/enums.ts src/shared/core/index.ts src/backend/services/registry.ts src/backend/services/session/resources/session-lifecycle-event.accessor.ts src/backend/services/session/resources/session-lifecycle-event.accessor.test.ts
git commit -m "Add session lifecycle event storage"
```

---

### Task 2: Map, merge, deduplicate, and publish lifecycle transcript messages

**Files:**

- Modify: `src/shared/acp-protocol/protocol/messages.ts`
- Modify: `src/shared/acp-protocol/protocol.test.ts`
- Create: `src/backend/services/session/service/store/session-lifecycle-transcript.ts`
- Create: `src/backend/services/session/service/store/session-lifecycle-transcript.test.ts`
- Modify: `src/backend/services/session/service/session-domain.service.ts`
- Modify: `src/backend/services/session/service/session-domain.service.test.ts`
- Create: `src/backend/services/session/service/lifecycle/session-lifecycle-event.service.ts`
- Create: `src/backend/services/session/service/lifecycle/session-lifecycle-event.service.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-services.ts`

**Interfaces:**

- Consumes: `SessionLifecycleEventRecord`, `SessionLifecycleEventStore`, and the shared enum types from Task 1.
- Produces:

```ts
export interface SessionLifecycleMessage {
  eventId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  timestamp: string;
}

export function toLifecycleChatMessage(event: SessionLifecycleEventRecord): ChatMessage;
export function mergeLifecycleTranscript(
  transcript: ChatMessage[],
  events: SessionLifecycleEventRecord[]
): ChatMessage[];

// Returns true only when the stable lifecycle message was absent.
SessionDomainService.prototype.upsertLifecycleMessage = (
  sessionId: string,
  message: ChatMessage
) => boolean;

export interface RecordLifecycleEventInput {
  workspaceId: string;
  sessionId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  dedupeKey: string;
  createdAt?: Date;
}

SessionLifecycleEventService.prototype.record = (
  input: RecordLifecycleEventInput
) => Promise<SessionLifecycleEventRecord | null>;
SessionLifecycleEventService.prototype.hydrate = (sessionId: string) => Promise<void>;
```

- [ ] **Step 1: Add failing protocol and merge tests**

Add a protocol test proving `session_lifecycle` is accepted by `AGENT_MESSAGE_TYPES`. Add merge tests:

```ts
it('maps an event to a stable structured chat message', () => {
  expect(toLifecycleChatMessage(eventRecord)).toEqual({
    id: 'session-lifecycle:event-1',
    source: 'agent',
    timestamp: '2026-07-30T12:22:23.353Z',
    order: 0,
    message: {
      type: 'session_lifecycle',
      timestamp: '2026-07-30T12:22:23.353Z',
      lifecycle: {
        eventId: 'event-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'PROMPT_TIMEOUT',
        message: 'Turn stopped: reached the 4-hour limit.',
        timestamp: '2026-07-30T12:22:23.353Z',
      },
    },
  });
});

it('merges provider and lifecycle messages chronologically without duplicates', () => {
  const merged = mergeLifecycleTranscript(
    [providerMessageAtNoon, existingLifecycleMessage],
    [eventAtEleven, eventRecord]
  );

  expect(merged.map((message) => message.id)).toEqual([
    'session-lifecycle:event-at-eleven',
    'provider-at-noon',
    'session-lifecycle:event-1',
  ]);
  expect(merged.map((message) => message.order)).toEqual([0, 1, 2]);
});
```

- [ ] **Step 2: Run the protocol and merge tests**

Run:

```bash
pnpm vitest run src/shared/acp-protocol/protocol.test.ts src/backend/services/session/service/store/session-lifecycle-transcript.test.ts
```

Expected: FAIL because the message variant and merge helper do not exist.

- [ ] **Step 3: Extend the shared protocol**

Add `session_lifecycle` to `AgentMessage['type']` and `AGENT_MESSAGE_TYPE_MAP`, and add:

```ts
export interface SessionLifecycleMessage {
  eventId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  timestamp: string;
}
```

Add `lifecycle?: SessionLifecycleMessage` to `AgentMessage`. Import the enum types through `@/shared/core` on backend/client code and a relative `../../core/index.js` import inside the shared protocol package.

- [ ] **Step 4: Implement deterministic transcript mapping and merge**

Use stable IDs and a complete sort key:

```ts
export function toLifecycleChatMessage(event: SessionLifecycleEventRecord): ChatMessage {
  const timestamp = event.createdAt.toISOString();
  return {
    id: `session-lifecycle:${event.id}`,
    source: 'agent',
    timestamp,
    order: 0,
    message: {
      type: 'session_lifecycle',
      timestamp,
      lifecycle: {
        eventId: event.id,
        kind: event.kind,
        reason: event.reason,
        message: event.message,
        timestamp,
      },
    },
  };
}

export function mergeLifecycleTranscript(
  transcript: ChatMessage[],
  events: SessionLifecycleEventRecord[]
): ChatMessage[] {
  const byId = new Map(transcript.map((message) => [message.id, message]));
  for (const event of events) {
    const lifecycleMessage = toLifecycleChatMessage(event);
    byId.set(lifecycleMessage.id, lifecycleMessage);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.id.localeCompare(right.id)
    )
    .map((message, order) => ({ ...message, order }));
}
```

- [ ] **Step 5: Add failing domain and lifecycle-service tests**

Prove that a stable message emits once, duplicate records are harmless, persistence precedes emission, persistence failure logs and best-effort emits, and hydration re-merges after `clearSession`:

```ts
it('persists before publishing and publishes a duplicate only once', async () => {
  const calls: string[] = [];
  store.upsert.mockImplementation(async () => {
    calls.push('persist');
    return eventRecord;
  });
  vi.spyOn(domain, 'upsertLifecycleMessage').mockImplementation(() => {
    calls.push('upsert');
    return calls.filter((call) => call === 'upsert').length === 1;
  });
  vi.spyOn(domain, 'emitDelta').mockImplementation(() => calls.push('emit'));

  await service.record(input);
  await service.record(input);

  expect(calls.slice(0, 3)).toEqual(['persist', 'upsert', 'emit']);
  expect(calls.filter((call) => call === 'emit')).toHaveLength(1);
});

it('rehydrates lifecycle events after the in-memory store is cleared', async () => {
  store.findBySessionId.mockResolvedValue([eventRecord]);
  domain.clearSession('session-1');

  await service.hydrate('session-1');

  expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toContain(
    'session-lifecycle:event-1'
  );
});
```

- [ ] **Step 6: Run the new service tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/session-domain.service.test.ts src/backend/services/session/service/lifecycle/session-lifecycle-event.service.test.ts
```

Expected: FAIL because `upsertLifecycleMessage` and `SessionLifecycleEventService` do not exist.

- [ ] **Step 7: Implement domain upsert and the lifecycle-event service**

Add a domain method that checks the stable ID before upserting:

```ts
upsertLifecycleMessage(sessionId: string, message: ChatMessage): boolean {
  const store = this.registry.getOrCreateActive(sessionId);
  const existed = store.transcript.some((entry) => entry.id === message.id);
  upsertTranscriptMessage(store, message);
  return !existed;
}
```

Implement `SessionLifecycleEventService.record` so it:

1. calls `store.upsert` with `createdAt ?? new Date()`;
2. converts the returned row with `toLifecycleChatMessage`;
3. calls `domain.upsertLifecycleMessage`;
4. emits `{ type: 'agent_message', data: lifecycleChatMessage.message }` only when newly inserted in memory;
5. on persistence failure, logs the full error, constructs a best-effort transient lifecycle message, upserts/emits it, and returns `null`;
6. never logs that the event was durable when the accessor rejected.

Implement `hydrate` so it catches and logs `findBySessionId` errors, otherwise calls `mergeLifecycleTranscript(domain.getTranscriptSnapshot(sessionId), events)` and `domain.replaceTranscript(sessionId, merged)`.

Construct and export `sessionLifecycleEventService` in `session-services.ts` before the prompt/lifecycle coordinators.

- [ ] **Step 8: Verify transcript behavior**

Run:

```bash
pnpm vitest run src/shared/acp-protocol/protocol.test.ts src/backend/services/session/service/store/session-lifecycle-transcript.test.ts src/backend/services/session/service/session-domain.service.test.ts src/backend/services/session/service/lifecycle/session-lifecycle-event.service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit the transcript foundation**

```bash
git add src/shared/acp-protocol src/backend/services/session/service/store/session-lifecycle-transcript.ts src/backend/services/session/service/store/session-lifecycle-transcript.test.ts src/backend/services/session/service/session-domain.service.ts src/backend/services/session/service/session-domain.service.test.ts src/backend/services/session/service/lifecycle/session-lifecycle-event.service.ts src/backend/services/session/service/lifecycle/session-lifecycle-event.service.test.ts src/backend/services/session/service/lifecycle/session-services.ts
git commit -m "Merge durable lifecycle events into chat"
```

---

### Task 3: Hydrate lifecycle events on load and render them in chat

**Files:**

- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/session.router.test.ts`
- Create: `src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.tsx`
- Create: `src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx`
- Create: `src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.stories.tsx`
- Modify: `src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.tsx`
- Modify: `src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.test.tsx`
- Modify: `src/client/features/chat/chat-reducer.test.ts`

**Interfaces:**

- Consumes: `sessionLifecycleEventService.hydrate(sessionId)` and `AgentMessage.lifecycle` from Task 2.
- Produces:

```ts
SessionLifecycleService.prototype.persistClosedSession = (
  sessionId: string
) => Promise<void>;

export function SessionLifecycleMessageRenderer(props: {
  message: AgentMessage;
  className?: string;
}): React.JSX.Element | null;
```

- [ ] **Step 1: Add failing load and closed-transcript recovery tests**

In the load-handler test, mock the lifecycle-event service and assert ordering:

```ts
it('hydrates lifecycle events after provider history and before replay', async () => {
  await handler(context);

  expect(hydrateProviderHistoryInvocation).toBeLessThan(
    vi.mocked(sessionLifecycleEventService.hydrate).mock.invocationCallOrder[0]!
  );
  expect(vi.mocked(sessionLifecycleEventService.hydrate).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(sessionDomainService.subscribe).mock.invocationCallOrder[0]!
  );
});
```

In the lifecycle test for closed transcript persistence, clear the domain store, return one lifecycle event from the accessor, call `persistClosedSession('session-1')`, and assert the saved `messages` includes `session-lifecycle:event-1`. In the session-router test, assert delete calls `stopSession`, then `persistClosedSession`, then clears memory and deletes the row.

- [ ] **Step 2: Run backend hydration tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: FAIL because neither path hydrates lifecycle events.

- [ ] **Step 3: Hydrate at both recovery boundaries**

In `createLoadSessionHandler`, add:

```ts
await hydrateProviderHistoryIfNeeded(sessionId, dbSession);
await sessionLifecycleEventService.hydrate(sessionId);
```

Wrap the call inside `hydrate` itself, so a database read failure logs and returns without blocking `subscribe`.

Inject `lifecycleEventService` into `SessionLifecycleService`. Extract the existing ratchet persistence body into a public `persistClosedSession(sessionId)` method that loads the session, calls:

```ts
await this.lifecycleEventService.hydrate(sessionId);
```

then reads the transcript and persists it with `closedSessionPersistenceService`. Make `persistRatchetTranscript` delegate to the shared implementation. In the `deleteSession` mutation, call `persistClosedSession(input.id)` after the explicit close stop and before `clearSession` and `deleteAgentSession`. This guarantees both ordinary closed sessions and restarted ratchet sessions include durable lifecycle rows before the transcript artifact is written.

- [ ] **Step 4: Add failing renderer tests**

Cover every reason and severity:

```tsx
it.each([
  ['PROMPT_TIMEOUT', 'Turn stopped: reached the 4-hour limit.', 'warning'],
  ['USER_STOP', 'Session stopped by you.', 'warning'],
  ['SESSION_CLOSED', 'Session closed by you.', 'warning'],
  ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.', 'warning'],
  ['SYSTEM_STOP', 'Session stopped by the system.', 'warning'],
  ['PROVIDER_ERROR', 'Turn stopped: Codex returned HTTP 529 (Overloaded).', 'error'],
  ['UNEXPECTED_EXIT', 'Session stopped: agent process exited unexpectedly (code 1).', 'error'],
] as const)('renders %s copy with %s severity', (reason, copy, severity) => {
  render(<SessionLifecycleMessageRenderer message={lifecycleMessage(reason, copy)} />);
  expect(screen.getByText(copy)).toBeVisible();
  expect(screen.getByTestId('session-lifecycle-message')).toHaveAttribute(
    'data-severity',
    severity
  );
});
```

Add an assistant-renderer integration test proving a `session_lifecycle` message reaches the dedicated renderer.

Add reducer coverage proving current runtime state cannot erase history:

```ts
it('keeps lifecycle history through runtime updates and reconnect replay', () => {
  const lifecycle = {
    type: 'session_lifecycle',
    lifecycle: {
      eventId: 'event-1',
      kind: 'TURN_INTERRUPTED',
      reason: 'PROMPT_TIMEOUT',
      message: 'Turn stopped: reached the 4-hour limit.',
      timestamp: '2026-07-30T12:22:23.353Z',
    },
  } satisfies AgentMessage;
  const live = chatReducer(initialState, {
    type: 'WS_AGENT_MESSAGE',
    payload: { message: lifecycle, messageId: 'session-lifecycle:event-1', order: 3 },
  });
  const idle = chatReducer(live, {
    type: 'SESSION_RUNTIME_UPDATED',
    payload: {
      sessionRuntime: {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: '2026-07-30T12:22:24.000Z',
      },
    },
  });
  const replayed = chatReducer(initialState, {
    type: 'SESSION_REPLAY_BATCH',
    payload: {
      replayEvents: [
        {
          type: 'agent_message',
          data: lifecycle,
          messageId: 'session-lifecycle:event-1',
          order: 3,
        },
      ],
    },
  });

  expect(idle.messages.map((message) => message.id)).toContain(
    'session-lifecycle:event-1'
  );
  expect(replayed.messages.map((message) => message.id)).toContain(
    'session-lifecycle:event-1'
  );
});
```

- [ ] **Step 5: Run renderer tests**

Run:

```bash
pnpm vitest run src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.test.tsx
```

Expected: FAIL because the renderer and branch do not exist.

- [ ] **Step 6: Implement the lifecycle row and Storybook states**

Use `WarningCircleIcon` for non-error reasons and `XCircleIcon` for error reasons. Render `message.lifecycle.message` and:

```tsx
<time dateTime={message.lifecycle.timestamp}>
  {new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(message.lifecycle.timestamp))}
</time>
```

The root must expose:

```tsx
<div
  data-testid="session-lifecycle-message"
  data-severity={isError ? 'error' : 'warning'}
  className={cn(
    'my-2 flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
    isError
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : 'border-amber-500/30 bg-amber-500/5 text-muted-foreground',
    className
  )}
>
```

Add the renderer branch before generic text extraction:

```tsx
if (message.type === 'session_lifecycle') {
  return <SessionLifecycleMessageRenderer message={message} className={className} />;
}
```

Create Storybook stories for a four-hour timeout, HTTP 529 overload, manual stop, and unexpected exit.

- [ ] **Step 7: Verify hydration and UI**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/trpc/session.router.test.ts src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.test.tsx src/client/features/chat/chat-reducer.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit load and rendering behavior**

```bash
git add src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.ts src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/trpc/session.trpc.ts src/backend/trpc/session.router.test.ts src/client/features/chat/agent-activity/message-renderers src/client/features/chat/chat-reducer.test.ts
git commit -m "Show lifecycle reasons in session chat"
```

---

### Task 4: Record prompt timeouts and provider failures with one turn key

**Files:**

- Modify: `src/backend/services/session/service/lifecycle/acp-event-processor.ts`
- Modify: `src/backend/services/session/service/lifecycle/acp-event-processor.text-streaming.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.prompt.service.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-services.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.error-message.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.error-message.test.ts`

**Interfaces:**

- Consumes: `SessionLifecycleEventService.record` from Task 2 and `PromptTimeoutError` from `@/backend/services/session/service/acp`.
- Produces:

```ts
AcpEventProcessor.prototype.beginPromptTurn = (sessionId: string) => string;
AcpEventProcessor.prototype.getActivePromptAttemptKey = (
  sessionId: string
) => string | undefined;
AcpEventProcessor.prototype.getProvider = (
  sessionId: string
) => 'CLAUDE' | 'CODEX' | undefined;

export function toPublicProviderErrorMessage(error: unknown): string;
export function toProviderFailureChatMessage(
  provider: 'CLAUDE' | 'CODEX' | undefined,
  error: unknown
): string;
```

- [ ] **Step 1: Add failing attempt-key and error-sanitization tests**

Assert each turn receives a UUID-like stable key, the key remains accessible until `finishPromptTurn`, and different turns differ. Add:

```ts
it.each([
  ['  HTTP 529:   Overloaded  ', 'HTTP 529 (Overloaded)'],
  ['request failed: secret-token=abc', 'The provider returned an error.'],
  [`HTTP 500 ${'x'.repeat(400)}`, `HTTP 500 ${'x'.repeat(231)}`],
])('normalizes public provider text', (input, expected) => {
  expect(toPublicProviderErrorMessage(new Error(input))).toBe(expected);
});

it('adds the provider name and terminal punctuation', () => {
  expect(toProviderFailureChatMessage('CODEX', new Error('HTTP 529: Overloaded'))).toBe(
    'Turn stopped: Codex returned HTTP 529 (Overloaded).'
  );
});
```

The sanitizer may retain `HTTP <status>`, `Overloaded`, and concise provider wording. It must return `The provider returned an error.` for text containing token/key/authorization/credential patterns and slice the final string to 240 characters.

- [ ] **Step 2: Run attempt-key and sanitizer tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/acp-event-processor.text-streaming.test.ts src/backend/services/session/service/lifecycle/session.error-message.test.ts
```

Expected: FAIL because the attempt-key API and sanitizer do not exist.

- [ ] **Step 3: Implement prompt attempt keys and bounded public errors**

Use `randomUUID` from `node:crypto`, an `activePromptAttemptKeys` map, and:

```ts
beginPromptTurn(sessionId: string): string {
  this.finishAcpTextBlock(sessionId);
  this.pendingAcpToolCalls.set(sessionId, new Map());
  const attemptKey = randomUUID();
  this.activePromptAttemptKeys.set(sessionId, attemptKey);
  return attemptKey;
}

finishPromptTurn(sessionId: string): void {
  this.finishAcpTextBlock(sessionId);
  this.activePromptAttemptKeys.delete(sessionId);
}
```

Also clear the key from `clearSessionState`, and expose the already-tracked provider through `getProvider`. Implement `toPublicProviderErrorMessage` using whitespace collapse, case-insensitive secret-pattern rejection, overload-parenthesis normalization, and `slice(0, 240)`. Implement `toProviderFailureChatMessage` so `CODEX` displays as `Codex`, `CLAUDE` as `Claude`, an unknown provider as `The provider`, and the final copy has exactly one terminal period. When the sanitizer returns its generic safe sentence, return `Turn stopped: the provider returned an error.` without duplicating the provider phrase.

- [ ] **Step 4: Add failing four-hour, timeout, 529, and suppression tests**

In `session.prompt.service.test.ts`, inject a mocked lifecycle-event service and assert:

```ts
it('uses the four-hour deadline for normal user messages', async () => {
  await service.sendSessionMessage('session-1', 'continue');
  expect(runtimeManager.sendPrompt).toHaveBeenCalledWith(
    'session-1',
    [{ type: 'text', text: 'continue' }],
    14_400_000
  );
});

it('records one durable timeout event for the active attempt', async () => {
  runtimeManager.sendPrompt.mockRejectedValue(
    new PromptTimeoutError('session-1', 14_400_000)
  );
  await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();
  expect(lifecycleEventService.record).toHaveBeenCalledOnce();
  expect(lifecycleEventService.record).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      kind: 'TURN_INTERRUPTED',
      reason: 'PROMPT_TIMEOUT',
      message: 'Turn stopped: reached the 4-hour limit.',
      dedupeKey: expect.stringMatching(/^turn:.+:stop$/),
    })
  );
});

it('preserves a useful HTTP 529 overload reason', async () => {
  runtimeManager.sendPrompt.mockRejectedValue(new Error('HTTP 529: Overloaded'));
  await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();
  expect(lifecycleEventService.record).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'PROVIDER_ERROR',
      message: 'Turn stopped: Codex returned HTTP 529 (Overloaded).',
    })
  );
});

it('does not record prompt cancellation after an explicit stop began', async () => {
  isSessionStopping.mockReturnValue(true);
  runtimeManager.sendPrompt.mockRejectedValue(new Error('Prompt cancelled'));
  await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();
  expect(lifecycleEventService.record).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run prompt tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.prompt.service.test.ts
```

Expected: FAIL on the one-hour timeout and missing event calls.

- [ ] **Step 6: Record prompt failures before completing the failed turn**

Change the constant:

```ts
const DEFAULT_USER_PROMPT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
```

Capture the key:

```ts
const attemptKey = this.acpEventProcessor.beginPromptTurn(sessionId);
```

In `executeAcpMessage`'s catch, before `completePromptTurnIfCurrent`, skip lifecycle recording when the turn-already-running guard fired, when `isSessionStopping(sessionId)` is true, or when the stop generation changed. Otherwise `await`:

```ts
await this.lifecycleEventService.record({
  workspaceId,
  sessionId,
  kind: SessionLifecycleEventKind.TURN_INTERRUPTED,
  reason:
    error instanceof PromptTimeoutError
      ? SessionLifecycleEventReason.PROMPT_TIMEOUT
      : SessionLifecycleEventReason.PROVIDER_ERROR,
  message:
    error instanceof PromptTimeoutError
      ? 'Turn stopped: reached the 4-hour limit.'
      : toProviderFailureChatMessage(this.acpEventProcessor.getProvider(sessionId), error),
  dedupeKey: `turn:${attemptKey}:stop`,
});
```

If `workspaceId` is missing, log the classification and do not fabricate a database owner.

Inject `lifecycleEventService` into `SessionService` in `session-services.ts`.

- [ ] **Step 7: Cover ACP error-message deduplication**

When `handleAcpDelta` sees an `agent_message` whose nested message has `type === 'error'`, use `getActivePromptAttemptKey(sid)` and call the same recorder with `turn:<attempt-key>:stop`. The later prompt rejection uses the identical key, so the unique database key and stable transcript ID keep one synthetic entry. Add a test that sends the ACP error and then rejects the prompt, and assert the transcript contains one lifecycle message.

- [ ] **Step 8: Verify all prompt paths**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/acp-event-processor.text-streaming.test.ts src/backend/services/session/service/lifecycle/session.error-message.test.ts src/backend/services/session/service/lifecycle/session.prompt.service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit prompt failure handling**

```bash
git add src/backend/services/session/service/lifecycle/acp-event-processor.ts src/backend/services/session/service/lifecycle/acp-event-processor.text-streaming.test.ts src/backend/services/session/service/lifecycle/session.service.ts src/backend/services/session/service/lifecycle/session.prompt.service.test.ts src/backend/services/session/service/lifecycle/session-services.ts src/backend/services/session/service/lifecycle/session.error-message.ts src/backend/services/session/service/lifecycle/session.error-message.test.ts
git commit -m "Record prompt failures and extend timeout"
```

---

### Task 5: Record explicit stop, close, archive, system stop, and unexpected exit

**Files:**

- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.test.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/session.router.test.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.test.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.test.ts`

**Interfaces:**

- Consumes: `SessionLifecycleEventService.record` from Task 2.
- Produces:

```ts
export type SessionStopReason =
  | 'USER_STOP'
  | 'SESSION_CLOSED'
  | 'WORKSPACE_ARCHIVED'
  | 'SYSTEM_STOP';

export type StopSessionOptions = {
  cleanupTransientRatchetSession?: boolean;
  reason?: SessionStopReason;
};

SessionLifecycleService.prototype.stopWorkspaceSessions = (
  workspaceId: string,
  options?: { reason?: SessionStopReason }
) => Promise<void>;
```

- [ ] **Step 1: Add failing stop-source tests**

Add lifecycle-service tests:

```ts
it.each([
  ['USER_STOP', 'Session stopped by you.'],
  ['SESSION_CLOSED', 'Session closed by you.'],
  ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.'],
  ['SYSTEM_STOP', 'Session stopped by the system.'],
] as const)('records %s before stopping the runtime', async (reason, message) => {
  await service.stopSession('session-1', { reason });

  expect(lifecycleEventService.record).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      kind: 'SESSION_STOPPED',
      reason,
      message,
      dedupeKey: expect.stringMatching(/^session-stop:\d+$/),
    })
  );
  expect(lifecycleEventService.record.mock.invocationCallOrder[0]).toBeLessThan(
    runtimeManager.stopClient.mock.invocationCallOrder[0]!
  );
});

it('records an unexpected process exit once with its exit code', async () => {
  await runtimeHandlers.onExit?.('session-1', 1);
  expect(lifecycleEventService.record).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'SESSION_STOPPED',
      reason: 'UNEXPECTED_EXIT',
      message: 'Session stopped: agent process exited unexpectedly (code 1).',
      dedupeKey: 'process-exit:4242:1',
    })
  );
});

it('does not label a deliberate stop as an unexpected exit', async () => {
  runtimeManager.isStopInProgress.mockReturnValue(true);
  await runtimeHandlers.onExit?.('session-1', 0);
  expect(lifecycleEventService.record).not.toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'UNEXPECTED_EXIT' })
  );
});
```

- [ ] **Step 2: Run lifecycle stop tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: FAIL because stop reasons are not recorded.

- [ ] **Step 3: Implement stop-reason recording**

Default internal calls to `SYSTEM_STOP`. After loading the session and before changing runtime state, persist:

```ts
await this.lifecycleEventService.record({
  workspaceId,
  sessionId,
  kind: SessionLifecycleEventKind.SESSION_STOPPED,
  reason,
  message: SESSION_STOP_MESSAGES[reason],
  dedupeKey: `session-stop:${this.getStopGeneration(sessionId)}`,
});
```

Use a complete typed map:

```ts
const SESSION_STOP_MESSAGES: Record<SessionStopReason, string> = {
  USER_STOP: 'Session stopped by you.',
  SESSION_CLOSED: 'Session closed by you.',
  WORKSPACE_ARCHIVED: 'Session stopped because the workspace was archived.',
  SYSTEM_STOP: 'Session stopped by the system.',
};
```

`stopWorkspaceSessions` forwards the supplied reason to every active/runtime session.

- [ ] **Step 4: Implement unexpected-exit recording**

In `onExit`, capture deliberate shutdown before runtime cleanup:

```ts
const wasDeliberateStop =
  this.stoppingSessions.has(sid) || this.runtimeManager.isStopInProgress(sid);
```

After loading/updating the session, when false, record:

```ts
await this.lifecycleEventService.record({
  workspaceId: session.workspaceId,
  sessionId: sid,
  kind: SessionLifecycleEventKind.SESSION_STOPPED,
  reason: SessionLifecycleEventReason.UNEXPECTED_EXIT,
  message:
    exitCode === null
      ? 'Session stopped: agent process exited unexpectedly.'
      : `Session stopped: agent process exited unexpectedly (code ${exitCode}).`,
  dedupeKey: `process-exit:${session.providerProcessPid ?? 'unknown'}:${exitCode ?? 'signal'}`,
});
```

This is separate from a preceding provider turn error because process death is independently useful, while deliberate shutdown is excluded.

- [ ] **Step 5: Add failing caller-intent tests**

Update tests to require:

```ts
expect(stopSession).toHaveBeenCalledWith('session-1', { reason: 'USER_STOP' });
expect(stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1', {
  reason: 'WORKSPACE_ARCHIVED',
});
expect(stopSession).toHaveBeenCalledWith('session-1', { reason: 'SESSION_CLOSED' });
```

Cover the chat stop handler, session tRPC stop/delete mutations, workspace archive cleanup, and the event collector's archived-workspace cleanup. Keep the `persistClosedSession` assertion added in Task 3 when updating the delete expectation.

- [ ] **Step 6: Run caller-intent tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/trpc/session.router.test.ts
```

Expected: FAIL because callers do not pass typed stop causes.

- [ ] **Step 7: Thread the reason through callers**

Make the chat stop handler and explicit tRPC stop action call:

```ts
await sessionLifecycleService.stopSession(sessionId, { reason: 'USER_STOP' });
```

Make session deletion/close call:

```ts
await sessionLifecycleService.stopSession(sessionId, { reason: 'SESSION_CLOSED' });
```

before deleting the `AgentSession`. Make archive cleanup and the archived-workspace collector call:

```ts
await sessionLifecycleService.stopWorkspaceSessions(workspaceId, {
  reason: 'WORKSPACE_ARCHIVED',
});
```

Leave restart, auto-iteration recycle, ratchet cleanup, startup cleanup, and server shutdown on the default `SYSTEM_STOP`.

- [ ] **Step 8: Verify all stop paths**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/trpc/session.router.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit stop-source handling**

```bash
git add src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.ts src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.test.ts src/backend/trpc/session.trpc.ts src/backend/trpc/session.router.test.ts src/backend/orchestration/workspace-archive.orchestrator.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.ts src/backend/orchestration/event-collector.orchestrator.test.ts
git commit -m "Record session stop causes"
```

---

### Task 6: Document and verify the complete behavior

**Files:**

- Modify: `AGENTS.md` under `ACP Runtime`
- Modify if required by formatting only: files touched in Tasks 1–5

**Interfaces:**

- Consumes: all behavior from Tasks 1–5.
- Produces: documented operating behavior and full-repository verification evidence.

- [ ] **Step 1: Update the ACP Runtime feature note**

Append this operational summary:

```md
Session stop history is durable: `SessionLifecycleEvent` rows are append-only,
deduplicated by session/attempt key, merged chronologically with provider
history, and rendered as structured chat rows after reconnect or restart.
Normal user turns have a fixed four-hour deadline; auto-iteration keeps its
separate configured deadline. Explicit stops, closes, workspace archives,
provider failures, prompt timeouts, and unexpected process exits record
distinct typed reasons.
```

- [ ] **Step 2: Format and run focused verification**

Run:

```bash
pnpm check:fix
pnpm db:generate
pnpm check:prisma-schema
pnpm check:service-registry
pnpm vitest run src/backend/services/session/resources/session-lifecycle-event.accessor.test.ts src/backend/services/session/service/store/session-lifecycle-transcript.test.ts src/backend/services/session/service/lifecycle/session-lifecycle-event.service.test.ts src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.test.ts src/backend/services/session/service/lifecycle/session.prompt.service.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.test.tsx src/client/features/chat/chat-reducer.test.ts
```

Expected: formatting produces no unexpected semantic changes and every focused check PASS.

- [ ] **Step 3: Run repository guardrails**

Run:

```bash
pnpm typecheck
pnpm check
pnpm test
pnpm build
```

Expected: all commands exit successfully. If an unrelated pre-existing failure occurs, preserve its exact output separately and still rerun every affected focused test.

- [ ] **Step 4: Review the final diff against the design**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- prisma/schema.prisma src/backend/services/session src/shared/acp-protocol src/client/features/chat src/backend/orchestration AGENTS.md
```

Confirm from the diff that:

- no provider transcript file is written;
- no auto-iteration timeout changed;
- every lifecycle row has a stable dedupe key;
- persistence precedes lifecycle live emission;
- reconnect hydration happens after provider hydration and before replay;
- provider and exit failures render as errors while deliberate stops render as warnings;
- generated Prisma changes correspond only to the new model/enums.

- [ ] **Step 5: Commit documentation and any format-only fixes**

```bash
git add AGENTS.md
git add -u
git commit -m "Document durable session stop history"
```

- [ ] **Step 6: Record final evidence**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: the worktree is clean and the six task commits are visible.
