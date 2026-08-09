# Provider-Initiated Sub-Agent Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Codex provider-initiated sub-agents in the workspace Agents panel and allow users to inspect their live or completed transcripts in a read-only drill-in view.

**Architecture:** The internal Codex adapter emits ordinary ACP tool calls with `factoryfactory.ai` metadata and implements a narrow ACP list/read extension. `AcpRuntimeManager` validates that extension and exposes it through the session tRPC router; existing session WebSockets carry invalidation events. A new client subagents feature renders the session-scoped list and projects paginated ACP transcript updates through the existing chat rendering model without creating database sessions or Prisma rows.

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk`, Codex app-server JSON-RPC, Zod, Express/tRPC, WebSockets, React 19, TanStack Query, Vitest, Storybook, Biome

## Global Constraints

- Use `factoryfactory.ai` for every ACP extension method, notification, capability, and metadata key.
- Codex is the only provider implementation in this plan; capability detection must keep the backend and client provider-neutral.
- Provider sub-agents remain read-only and are never represented as Factory Factory sessions, workspaces, or child workspaces.
- The provider remains the source of truth; add no Prisma model, snapshot field, export field, or backup payload.
- Show direct children of the currently selected parent session only; do not visualize deeper descendants in this release.
- Keep active sub-agents visible and place terminal outcomes under a collapsed `Completed · N` group.
- Keep the selected parent session tab active during drill-in, hide the composer, and preserve the parent transcript and scroll position.
- Keep existing child-workspace creation, navigation, polling, and archive behavior unchanged inside the renamed Agents tab.
- Validate extension capabilities, metadata, requests, responses, and notifications with Zod at the ACP boundary.
- Follow test-first red-green cycles, run focused tests after every task, and commit each task separately.

---

## File Structure

### Shared protocol

- Create `src/shared/acp-protocol/subagents.ts` for extension constants, Zod schemas, and provider-neutral DTOs.
- Create `src/shared/acp-protocol/subagents.test.ts` for contract parsing and rejection cases.
- Create `src/shared/acp-protocol/session-update-translator.ts` for the environment-neutral ACP update translator currently owned by the backend.
- Modify `src/shared/acp-protocol/index.ts` to publish the new contract and translator.
- Modify `src/shared/acp-protocol/protocol/websocket.ts` to add the `subagents_changed` session delta.

### Codex ACP adapter

- Create `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.ts` for Codex item-to-ACP tool metadata and status normalization.
- Create `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.test.ts` for singular/multi-receiver activity mapping.
- Create `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.ts` for parent-scoped list/read and invalidation.
- Create `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.test.ts` for app-server request, pagination, authorization, and normalization behavior.
- Modify `adapter-state.ts`, `codex-zod.ts`, `stream-event-handler.ts`, and `codex-app-server-acp-adapter.ts` to use those focused modules.
- Modify their existing tests and the manual integration test.

### Session runtime and transport

- Modify `acp-process-handle.ts` and `acp-runtime-manager.ts` to validate capability metadata and invoke extension methods.
- Modify `acp-client-handler.ts` and `acp-runtime-events.ts` to receive extension invalidations.
- Modify `acp-event-processor.ts` to publish `subagents_changed` through the existing session event stream.
- Modify `session.trpc.ts` to expose `listSubagents` and `readSubagentTranscript` queries.
- Create `src/client/lib/subagent-events.ts` for the typed browser invalidation event shared by chat transport and the subagents feature.
- Modify `use-chat-transport.ts` and the chat reducer's exhaustive WebSocket map to dispatch but not reduce that invalidation event.

### Client UI

- Create `src/client/features/chat/project-acp-transcript.ts` and its test to turn transcript ACP updates into existing `ChatMessage` objects.
- Create `src/client/features/subagents/` with a public barrel, list container, presentational list, transcript view, invalidation hook, tests, and stories.
- Create `src/client/features/workspace/agents-panel.tsx` to compose provider sub-agents with the existing child-workspace section.
- Create `src/client/features/workspace/right-panel-state.ts` and its test for the persisted `child-workspaces` to `agents` migration.
- Modify `right-panel.tsx`, `child-workspaces-panel.tsx`, `workspace-detail-view.tsx`, and their tests to support the new composition and drill-in state.

### Documentation

- Modify `AGENTS.md` to document provider-initiated sub-agent visibility separately from child workspaces.

---

### Task 1: Define the Provider-Neutral ACP Sub-Agent Contract

**Files:**
- Create: `src/shared/acp-protocol/subagents.ts`
- Create: `src/shared/acp-protocol/subagents.test.ts`
- Modify: `src/shared/acp-protocol/index.ts`

**Interfaces:**
- Produces: `SUBAGENTS_CAPABILITY_META_KEY`, `SUBAGENT_TOOL_META_KEY`, `SUBAGENTS_LIST_METHOD`, `SUBAGENTS_READ_METHOD`, and `SUBAGENTS_CHANGED_METHOD`
- Produces: `SubagentBrowseCapability`, `SubagentStatus`, `SubagentSummary`, `SubagentTranscriptUpdate`, `SubagentListParams`, `SubagentListResult`, `SubagentReadParams`, `SubagentReadResult`, and `SubagentsChangedParams`
- Produces: Zod schemas for every produced type and the supported ACP transcript update subset
- Consumes: Zod and ACP `SessionUpdate` field conventions

- [ ] **Step 1: Write failing contract tests**

Cover the exact namespace, capability version, all lifecycle states, cursor bounds, direct list/read payloads, valid transcript updates, unknown passthrough fields, and rejection of malformed IDs, dates, status values, and unsupported capability versions.

```typescript
expect(SUBAGENTS_LIST_METHOD).toBe('factoryfactory.ai/subagents/list');
expect(
  subagentBrowseCapabilitySchema.parse({
    version: 1,
    list: true,
    read: true,
    notifications: true,
  })
).toEqual({ version: 1, list: true, read: true, notifications: true });

expect(() =>
  subagentSummarySchema.parse({ id: '', name: null, status: 'unknown' })
).toThrow();
```

- [ ] **Step 2: Run the contract test and verify RED**

```bash
pnpm exec vitest run src/shared/acp-protocol/subagents.test.ts
```

Expected: FAIL because the contract module and exports do not exist.

- [ ] **Step 3: Implement constants, schemas, and inferred types**

Use one source of truth for runtime validation and TypeScript types:

```typescript
export const SUBAGENTS_CAPABILITY_META_KEY = 'factoryfactory.ai/subagents';
export const SUBAGENT_TOOL_META_KEY = 'factoryfactory.ai/subagent';
export const SUBAGENTS_LIST_METHOD = 'factoryfactory.ai/subagents/list';
export const SUBAGENTS_READ_METHOD = 'factoryfactory.ai/subagents/read';
export const SUBAGENTS_CHANGED_METHOD = 'factoryfactory.ai/subagents/changed';

export const subagentStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export const subagentListParamsSchema = z.object({
  sessionId: z.string().min(1),
  cursor: z.string().min(1).nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type SubagentSummary = z.infer<typeof subagentSummarySchema>;
export type SubagentReadResult = z.infer<typeof subagentReadResultSchema>;
```

Define a discriminated Zod union for the transcript updates the adapter produces: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, and `plan`. Mark individual objects `.passthrough()` so additive ACP fields do not break version 1.

- [ ] **Step 4: Run the contract test and verify GREEN**

```bash
pnpm exec vitest run src/shared/acp-protocol/subagents.test.ts src/shared/acp-protocol/protocol.test.ts
```

Expected: both files pass and the root shared barrel resolves every new symbol.

- [ ] **Step 5: Commit the ACP contract**

```bash
git add src/shared/acp-protocol/subagents.ts src/shared/acp-protocol/subagents.test.ts src/shared/acp-protocol/index.ts
git commit -m "Define ACP sub-agent inspection contract"
```

### Task 2: Surface Codex Sub-Agent Activity as Standard ACP Tool Calls

**Files:**
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.ts`
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/adapter-state.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts`

**Interfaces:**
- Produces: `SubagentToolMapping` with display data, `_meta`, and affected child thread IDs
- Produces: `mapCodexSubagentToolItem(item, parentSessionId): SubagentToolMapping | null`
- Modifies: `ToolCallState` to carry optional `meta: Record<string, unknown>`
- Consumes: `collabAgentToolCall` and `subAgentActivity` Codex thread items

- [ ] **Step 1: Write failing mapper and stream tests**

Require `subAgentActivity` to produce a singular provider-neutral ID, `collabAgentToolCall` with one receiver to produce the same metadata, multi-receiver calls to report every affected ID without inventing a singular ID, and started/completed stream events to retain `_meta` on standard ACP tool calls.

```typescript
expect(
  mapCodexSubagentToolItem(
    {
      type: 'subAgentActivity',
      id: 'item-1',
      agentThreadId: 'child-1',
      agentPath: 'review/security',
      kind: 'started',
    },
    'parent-1'
  )
).toMatchObject({
  title: 'Start subagent security',
  kind: 'other',
  affectedSubagentIds: ['child-1'],
  meta: {
    [SUBAGENT_TOOL_META_KEY]: {
      id: 'child-1',
      parentSessionId: 'parent-1',
    },
  },
});
```

- [ ] **Step 2: Run focused adapter tests and verify RED**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts
```

Expected: FAIL because both Codex item types are reported as unhandled and tool-call state drops metadata.

- [ ] **Step 3: Add tolerant Codex item schemas and the focused mapper**

Parse the fields Factory Factory reads and keep the rest passthrough:

```typescript
const subAgentActivityItemSchema = threadItemSchema.extend({
  type: z.literal('subAgentActivity'),
  agentThreadId: z.string().min(1),
  agentPath: z.string(),
  kind: z.enum(['started', 'interacted', 'interrupted']),
});

const collabAgentToolCallItemSchema = threadItemSchema.extend({
  type: z.literal('collabAgentToolCall'),
  tool: z.string(),
  senderThreadId: z.string(),
  receiverThreadIds: z.array(z.string()),
  status: z.string(),
}).passthrough();
```

The mapper must return stable launch/interact/interrupt titles, ACP kind `other`, no filesystem locations, and `affectedSubagentIds` for invalidation. Attach singular `factoryfactory.ai/subagent` metadata only when one child can be identified.

- [ ] **Step 4: Preserve metadata through start, progress, completion, and replay**

Extend tool state and every tool emission path:

```typescript
export type ToolCallState = {
  toolCallId: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  title: string;
  locations: Array<{ path: string; line?: number | null }>;
  meta?: Record<string, unknown>;
  affectedSubagentIds?: string[];
};

const meta = toolInfo.meta ? { _meta: toolInfo.meta } : {};
await emitSessionUpdate(sessionId, {
  sessionUpdate: 'tool_call',
  toolCallId: toolInfo.toolCallId,
  title: toolInfo.title,
  kind: toolInfo.kind,
  status: 'pending',
  ...meta,
});
```

Do not advertise the browse capability in this task; the standard tool-call behavior must remain useful by itself.

- [ ] **Step 5: Run focused adapter tests and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts
```

Expected: all mapper, schema, stream, and adapter tests pass; existing command/file/MCP tool tests remain unchanged.

- [ ] **Step 6: Commit standard ACP activity mapping**

```bash
git add src/backend/services/session/service/acp/codex-app-server-adapter
git commit -m "Surface Codex sub-agents through ACP tools"
```

### Task 3: Implement Codex Parent-Scoped List, Read, and Invalidation

**Files:**
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.ts`
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts`

**Interfaces:**
- Produces: `CodexSubagentController.list(params): Promise<SubagentListResult>`
- Produces: `CodexSubagentController.read(params): Promise<SubagentReadResult>`
- Produces: `CodexSubagentController.notifyChanged(parentSessionId, subagentId, change): Promise<void>`
- Produces: parent lookup for Codex `thread/status/changed` invalidation, populated from activity and authoritative list results
- Produces: adapter `extMethod(method, params): Promise<Record<string, unknown>>`
- Consumes: parent `AdapterSession`, Codex `thread/list`, Codex `thread/read`, Task 2 tool mappings, and `AgentSideConnection.extNotification`

- [ ] **Step 1: Write failing list and authorization tests**

Require list to call `thread/list` with the parent's thread ID, cursor, limit, creation ordering, and experimental `parentThreadId`. Normalize name, timestamps, status, preview, and terminal last-turn outcome. Require no descendants from another parent, and require returned direct-child IDs to populate the controller's parent lookup.

```typescript
expect(codex.request).toHaveBeenCalledWith('thread/list', {
  parentThreadId: 'parent-thread-1',
  cursor: null,
  limit: 50,
  sortKey: 'created_at',
  sortDirection: 'asc',
});
expect(result.subagents.map((item) => item.id)).toEqual(['child-thread-1']);
```

- [ ] **Step 2: Write failing read and cursor tests**

Use a parent with two children and a foreign thread. Require `read` to re-list/verify direct ownership before `thread/read`, reject the foreign ID with `RequestError.invalidParams`, select the newest `limit` complete turns initially, return updates in chronological order, and encode the first selected turn ID into an opaque cursor for older pages.

```typescript
const first = await controller.read({
  sessionId: 'parent-session-1',
  subagentId: 'child-thread-1',
  cursor: null,
  limit: 2,
});
expect(first.updates.at(-1)).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
expect(first.nextCursor).toEqual(expect.any(String));
```

After the list establishes correlation, feed `thread/status/changed` for one direct child and one unrelated thread. Require exactly one namespaced `completed` notification for the direct child and none for the unrelated thread.

- [ ] **Step 3: Run focused controller tests and verify RED**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts
```

Expected: FAIL because the adapter has no extension handler, parent-filtered schemas, or transcript collector.

- [ ] **Step 4: Add Codex list/read schemas and status normalization**

Parse only required thread fields and retain additive fields. Map runtime and last-turn status as follows:

```typescript
function normalizeCodexSubagentStatus(input: {
  runtimeType?: string;
  activeFlags?: readonly string[];
  lastTurnStatus?: string;
}): SubagentStatus {
  if (input.runtimeType === 'active') {
    if (
      input.activeFlags?.includes('waitingOnApproval') ||
      input.activeFlags?.includes('waitingOnUserInput')
    ) {
      return 'waiting';
    }
    return 'running';
  }
  if (input.runtimeType === 'systemError' || input.lastTurnStatus === 'failed') return 'failed';
  if (input.lastTurnStatus === 'interrupted') return 'interrupted';
  return 'completed';
}
```

Codex does not expose distinct thread or turn states for the provider-neutral `starting` and
`cancelled` values. Preserve its explicit `interrupted` outcome instead of inventing a cancellation
state, and use the active wait flags for the observable `waiting` state.

For terminal threads, inspect the last turn returned by `thread/read` when the list response does not contain enough outcome data. Use the last agent message as `resultPreview`, trim whitespace, and cap it at 240 characters. Limit concurrent terminal-summary reads to four.

- [ ] **Step 5: Refactor history replay into a reusable collector**

Keep existing session replay behavior while allowing a synthetic, unregistered child projection session:

```typescript
async projectThreadTurns(
  session: AdapterSession,
  turns: ThreadReadTurn[]
): Promise<SessionUpdate[]>;

async replayThreadHistory(sessionId: string, threadId: string): Promise<void> {
  const updates = await this.projectThreadTurns(session, thread.turns);
  for (const update of updates) await this.deps.emitSessionUpdate(sessionId, update);
}
```

Create the projection session from the parent's cwd/defaults with fresh tool/replay maps; never register it in `sessionIdByThreadId` or mutate the parent's replay state.

- [ ] **Step 6: Implement extension routing, capability advertisement, and invalidation**

Advertise capability only now that both methods exist:

```typescript
agentCapabilities: {
  loadSession: true,
  promptCapabilities: existingPromptCapabilities,
  _meta: {
    [SUBAGENTS_CAPABILITY_META_KEY]: {
      version: 1,
      list: true,
      read: true,
      notifications: true,
    },
  },
}
```

Parse params before dispatch and results before returning. Throw `RequestError.methodNotFound(method)` for every other extension method. On Task 2 activity items, remember child-to-parent correlation and emit one `factoryfactory.ai/subagents/changed` notification per affected child with `created`, `updated`, or `completed`. Parse Codex `thread/status/changed`; when its thread ID is a remembered direct child, map active status to `updated` and terminal status to `completed` for the same parent. Ignore unrelated thread IDs. Notification failure must not fail the parent turn.

- [ ] **Step 7: Run focused controller and adapter tests and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-zod.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts
```

Expected: list/read authorization, status, cursor, transcript, capability, notification, and existing replay tests pass.

- [ ] **Step 8: Commit Codex browsing support**

```bash
git add src/backend/services/session/service/acp/codex-app-server-adapter
git commit -m "Add Codex ACP sub-agent browsing"
```

### Task 4: Add Provider-Neutral Runtime Methods and Extension Notifications

**Files:**
- Modify: `src/backend/services/session/service/acp/acp-process-handle.ts`
- Create: `src/backend/services/session/service/acp/acp-process-handle.test.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-manager.test.ts`
- Modify: `src/backend/services/session/service/acp/acp-client-handler.ts`
- Modify: `src/backend/services/session/service/acp/acp-client-handler.test.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-events.ts`
- Modify: `src/backend/services/session/service/acp/index.ts`
- Modify: `src/backend/services/session/service/index.ts`

**Interfaces:**
- Produces: `AcpProcessHandle.getSubagentBrowseCapability(): SubagentBrowseCapability | null`
- Produces: `AcpRuntimeManager.getSubagentBrowseCapability(sessionId): SubagentBrowseCapability | null`
- Produces: `AcpRuntimeManager.listSubagents(sessionId, input): Promise<SubagentListResult>`
- Produces: `AcpRuntimeManager.readSubagentTranscript(sessionId, input): Promise<SubagentReadResult>`
- Produces: `AcpSubagentsChangedEvent` in `AcpRuntimeEvent`
- Consumes: Task 1 schemas and `ClientSideConnection.extMethod`

- [ ] **Step 1: Write failing capability and extension invocation tests**

Require a version-1 capability under `agentCapabilities._meta`, reject wrong versions/shapes, substitute the provider session ID before calling the adapter, pass cursors unchanged, parse both responses, and reject calls when no live handle or capability exists.

```typescript
mockExtMethod.mockResolvedValue({ subagents: [], nextCursor: null });
await manager.listSubagents('db-session-1', { cursor: null, limit: 50 });
expect(mockExtMethod).toHaveBeenCalledWith(SUBAGENTS_LIST_METHOD, {
  sessionId: 'provider-session-123',
  cursor: null,
  limit: 50,
});
```

- [ ] **Step 2: Write failing notification tests**

Call `AcpClientHandler.extNotification` with a valid change and require one DB-session-scoped runtime event. Require unknown extension notifications to log and resolve without dispatch, and malformed known notifications to log and resolve without crashing the ACP connection.

```typescript
await handler.extNotification(SUBAGENTS_CHANGED_METHOD, {
  sessionId: 'provider-session-123',
  subagentId: 'child-1',
  change: 'updated',
});
expect(onEvent).toHaveBeenCalledWith('db-session-1', {
  type: 'acp_subagents_changed',
  subagentId: 'child-1',
  change: 'updated',
});
```

- [ ] **Step 3: Run focused runtime tests and verify RED**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/acp-process-handle.test.ts src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/acp/acp-client-handler.test.ts
```

Expected: FAIL because capability parsing, runtime methods, and `extNotification` do not exist.

- [ ] **Step 4: Implement capability parsing and runtime methods**

Keep the DB session ID outside the extension boundary and require the live handle:

```typescript
getSubagentBrowseCapability(): SubagentBrowseCapability | null {
  const meta = this.agentCapabilities._meta;
  if (!isRecord(meta)) return null;
  const parsed = subagentBrowseCapabilitySchema.safeParse(meta[SUBAGENTS_CAPABILITY_META_KEY]);
  return parsed.success ? parsed.data : null;
}

async listSubagents(
  sessionId: string,
  input: Omit<SubagentListParams, 'sessionId'>
): Promise<SubagentListResult>;

getSubagentBrowseCapability(sessionId: string): SubagentBrowseCapability | null;
```

Call `connection.extMethod`, parse the returned record, and keep method-not-found/provider errors typed and visible to the caller.

- [ ] **Step 5: Implement known extension notification routing**

Add `extNotification` to `AcpClientHandler`, extend `AcpRuntimeEvent`, and export the new types through the session capsule barrels. Keep logging before dispatch, matching ordinary ACP update behavior.

- [ ] **Step 6: Run focused runtime tests and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/session/service/acp/acp-process-handle.test.ts src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/acp/acp-client-handler.test.ts
```

Expected: all capability, invocation, response validation, notification, and existing runtime lifecycle tests pass.

- [ ] **Step 7: Commit the provider-neutral runtime boundary**

```bash
git add src/backend/services/session/service/acp src/backend/services/session/service/index.ts
git commit -m "Expose sub-agent browsing through ACP runtime"
```

### Task 5: Expose Session Queries and Live Invalidation Transport

**Files:**
- Modify: `src/shared/acp-protocol/protocol/websocket.ts`
- Modify: `src/shared/acp-protocol/protocol.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/acp-event-processor.ts`
- Create: `src/backend/services/session/service/lifecycle/acp-event-processor.subagents.test.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/session.router.test.ts`
- Create: `src/client/lib/subagent-events.ts`
- Modify: `src/client/features/chat/use-chat-transport.ts`
- Modify: `src/client/features/chat/use-chat-transport.test.ts`
- Modify: `src/client/features/chat/reducer/index.ts`

**Interfaces:**
- Produces: `subagents_changed` session delta with DB `sessionId`, `subagentId`, and change kind
- Produces: `session.listSubagents` query returning `{ supported: false }` or `{ supported: true, subagents, nextCursor }`
- Produces: `session.readSubagentTranscript` query returning `SubagentReadResult`
- Produces: `subscribeToSubagentChanges(listener): () => void` in the client
- Consumes: Task 4 runtime methods and the existing session publisher/WebSocket recursion

- [ ] **Step 1: Write failing protocol, processor, and transport tests**

Require a direct and `session_delta`-wrapped `subagents_changed` event to pass the runtime guard. Require `AcpEventProcessor` to convert the runtime event into one session-domain delta. Require chat transport to dispatch one typed browser event and no reducer action.

```typescript
expect(isWebSocketMessage({
  type: 'subagents_changed',
  sessionId: 'db-session-1',
  subagentId: 'child-1',
  change: 'completed',
})).toBe(true);
```

- [ ] **Step 2: Write failing router tests**

Cover unsupported capability, supported empty list, cursor forwarding, read forwarding, no live runtime, and adapter validation errors.

```typescript
await expect(caller.listSubagents({ sessionId: 'session-1', limit: 50 })).resolves.toEqual({
  supported: false,
});

expect(acpRuntimeManager.readSubagentTranscript).toHaveBeenCalledWith('session-1', {
  subagentId: 'child-1',
  cursor: null,
  limit: 10,
});
```

- [ ] **Step 3: Run focused transport tests and verify RED**

```bash
pnpm exec vitest run src/shared/acp-protocol/protocol.test.ts src/backend/services/session/service/lifecycle/acp-event-processor.subagents.test.ts src/backend/trpc/session.router.test.ts src/client/features/chat/use-chat-transport.test.ts
```

Expected: FAIL because the event union, processor branch, router procedures, and browser event helper do not exist.

- [ ] **Step 4: Add the session delta and processor branch**

```typescript
subagents_changed: {
  sessionId: string;
  subagentId: string;
  change: 'created' | 'updated' | 'completed';
};
```

Handle `acp_subagents_changed` before ordinary session updates and publish through `sessionDomainService.emitDelta`. This event is ephemeral and must not enter transcript persistence or replay.

- [ ] **Step 5: Add parent-session queries**

Use Zod input schemas with `limit` bounds from Task 1. `listSubagents` checks `getSubagentBrowseCapability()` before invoking the extension. `readSubagentTranscript` returns `PRECONDITION_FAILED` for unsupported sessions and lets typed invalid-relationship/provider errors flow through the existing tRPC error mapping.

- [ ] **Step 6: Dispatch a typed browser invalidation event**

```typescript
export const SUBAGENTS_CHANGED_BROWSER_EVENT = 'factoryfactory:subagents-changed';

export function subscribeToSubagentChanges(
  listener: (detail: SubagentChangeDetail) => void
): () => void;
```

Add `subagents_changed: null` to the reducer's exhaustive message map. In `useChatTransport`, dispatch through the helper and return before creating a reducer action.

- [ ] **Step 7: Run focused transport tests and verify GREEN**

```bash
pnpm exec vitest run src/shared/acp-protocol/protocol.test.ts src/backend/services/session/service/lifecycle/acp-event-processor.subagents.test.ts src/backend/trpc/session.router.test.ts src/client/features/chat/use-chat-transport.test.ts
```

Expected: protocol, runtime-to-domain, router, nested WebSocket, and browser event tests pass.

- [ ] **Step 8: Commit the application transport**

```bash
git add src/shared/acp-protocol/protocol/websocket.ts src/shared/acp-protocol/protocol.test.ts src/backend/services/session/service/lifecycle src/backend/trpc/session.trpc.ts src/backend/trpc/session.router.test.ts src/client/lib/subagent-events.ts src/client/features/chat
git commit -m "Add sub-agent session queries and invalidation"
```

### Task 6: Reuse the Chat Model for Read-Only ACP Transcript Pages

**Files:**
- Create: `src/shared/acp-protocol/session-update-translator.ts`
- Create: `src/shared/acp-protocol/session-update-translator.test.ts`
- Modify: `src/shared/acp-protocol/index.ts`
- Modify: `src/backend/services/session/service/acp/acp-event-translator.ts`
- Modify: `src/backend/services/session/service/acp/acp-event-translator.test.ts`
- Create: `src/client/features/chat/project-acp-transcript.ts`
- Create: `src/client/features/chat/project-acp-transcript.test.ts`
- Modify: `src/client/features/chat/index.ts`

**Interfaces:**
- Produces: shared `AcpEventTranslator` with no backend import
- Produces: `projectAcpTranscriptUpdates(updates): ChatMessage[]`
- Consumes: Task 1 transcript update union, existing chat reducer helpers, and current ACP translation semantics

- [ ] **Step 1: Write failing environment-neutral translation tests**

Move the existing translator expectations to the shared module without changing live translation semantics. Require malformed data to warn and return no deltas.

```typescript
const translator = new AcpEventTranslator({ warn: vi.fn() });
expect(
  translator.translateSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Finished review' },
  })
).toMatchObject([{ type: 'agent_message' }]);
```

- [ ] **Step 2: Write failing transcript projection tests**

Use a transcript containing user text, assistant text, reasoning, a pending command tool call, its terminal update, and a second assistant result. Require deterministic message order, one paired tool result, no pending composer state, and identical projection when the same pages are recombined.

```typescript
const messages = projectAcpTranscriptUpdates(updates);
expect(messages.map((message) => message.source)).toEqual([
  'user',
  'agent',
  'agent',
  'agent',
  'agent',
]);
expect(messages.some((message) => message.message?.type === 'tool_result')).toBe(true);
```

- [ ] **Step 3: Run translation and projection tests and verify RED**

```bash
pnpm exec vitest run src/shared/acp-protocol/session-update-translator.test.ts src/backend/services/session/service/acp/acp-event-translator.test.ts src/client/features/chat/project-acp-transcript.test.ts
```

Expected: FAIL because the shared translator and read-only projector do not exist.

- [ ] **Step 4: Move the translator behind an environment-neutral logger interface**

```typescript
export type AcpTranslationLogger = {
  warn(message: string, details?: unknown): void;
};

export class AcpEventTranslator {
  constructor(private readonly logger: AcpTranslationLogger) {}
  translateSessionUpdate(update: TranslatableSessionUpdate): SessionDeltaEvent[];
}
```

Keep `src/backend/.../acp-event-translator.ts` as a compatibility re-export so existing internal imports do not widen or duplicate implementation.

- [ ] **Step 5: Implement deterministic read-only projection**

Handle `user_message_chunk` directly as a user `ChatMessage`. Translate the remaining updates, allocate monotonically increasing `order`, and run the same chat reducer actions used for WebSocket messages. Use deterministic IDs derived from page order and tool-call IDs; use a fixed ISO timestamp when provider history has none.

```typescript
const TRANSCRIPT_FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function projectAcpTranscriptUpdates(
  updates: SubagentTranscriptUpdate[]
): ChatMessage[] {
  const translator = new AcpEventTranslator(transcriptLogger);
  let state = createInitialChatState({ sessionStatus: { phase: 'ready' } });
  let order = 0;

  for (const update of updates) {
    if (update.sessionUpdate === 'user_message_chunk') {
      const message: ChatMessage = {
        id: `subagent-user-${order}`,
        source: 'user',
        text: readTextContent(update.content),
        timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
        order,
      };
      state = chatReducer(state, { type: 'USER_MESSAGE_SENT', payload: message });
      order += 1;
      continue;
    }

    for (const delta of translator.translateSessionUpdate(update)) {
      const message = {
        ...delta,
        order,
        messageId: `subagent-event-${order}`,
      };
      if (isWebSocketMessage(message)) {
        const action = createActionFromWebSocketMessage(message);
        if (action) {
          state = chatReducer(state, action);
        }
      }
      order += 1;
    }
  }

  return state.messages.map((message, index) => ({
    ...message,
    id: `subagent-message-${message.order}-${index}`,
    timestamp: TRANSCRIPT_FALLBACK_TIMESTAMP,
  }));
}
```

`readTextContent` accepts only ACP text chunks without coercing image/resource blocks. `transcriptLogger` is a module-local no-op logger. The function must be pure: do not read the DOM, mutate input pages, reuse live session reducer state, or leak reducer-generated IDs/timestamps into the result.

- [ ] **Step 6: Run translation and projection tests and verify GREEN**

```bash
pnpm exec vitest run src/shared/acp-protocol/session-update-translator.test.ts src/backend/services/session/service/acp/acp-event-translator.test.ts src/backend/services/session/service/lifecycle/acp-event-processor.text-streaming.test.ts src/client/features/chat/project-acp-transcript.test.ts
```

Expected: shared translation, existing live ACP processing, and read-only transcript projection pass together.

- [ ] **Step 7: Commit transcript reuse**

```bash
git add src/shared/acp-protocol src/backend/services/session/service/acp/acp-event-translator.ts src/backend/services/session/service/acp/acp-event-translator.test.ts src/client/features/chat/project-acp-transcript.ts src/client/features/chat/project-acp-transcript.test.ts src/client/features/chat/index.ts
git commit -m "Project ACP sub-agent transcripts into chat"
```

### Task 7: Build the Agents Panel and Session-Scoped Sub-Agent List

**Files:**
- Create: `src/client/features/subagents/index.ts`
- Create: `src/client/features/subagents/types.ts`
- Create: `src/client/features/subagents/use-subagent-invalidation.ts`
- Create: `src/client/features/subagents/subagent-list.tsx`
- Create: `src/client/features/subagents/subagent-list.test.tsx`
- Create: `src/client/features/subagents/subagent-list.stories.tsx`
- Create: `src/client/features/subagents/provider-subagents-section.tsx`
- Create: `src/client/features/subagents/provider-subagents-section.test.tsx`
- Create: `src/client/features/workspace/agents-panel.tsx`
- Create: `src/client/features/workspace/agents-panel.test.tsx`
- Create: `src/client/features/workspace/right-panel-state.ts`
- Create: `src/client/features/workspace/right-panel-state.test.ts`
- Modify: `src/client/features/workspace/child-workspaces-panel.tsx`
- Modify: `src/client/features/workspace/right-panel.tsx`
- Create: `src/client/features/workspace/right-panel.test.tsx`
- Modify: `src/client/features/workspace/index.ts`

**Interfaces:**
- Produces: `SubagentSelection` and `SubagentListItem` client types inferred from `AppRouter`
- Produces: `ProviderSubagentsSection({ sessionId, enabled, onSelect })`
- Produces: `AgentsPanel({ workspaceId, sessionId, sessionReady, isParentWorkspace, onOpenSubagent })`
- Produces: `parseStoredTopTab(value): TopPanelTab | null` and `loadPersistedTopPanelState(storage, workspaceId)` with legacy migration
- Consumes: Task 5 list query and browser invalidation event

- [ ] **Step 1: Write failing presentational list tests**

Require provider/fallback names, normalized status, elapsed time, and active previews. Require active rows to render oldest first and completed rows newest first beneath a collapsed `Completed · N` control; expansion reveals terminal statuses/result previews. Cover row selection, loading, empty, unsupported, and contained error states with fake time for stable elapsed labels.

```typescript
expect(screen.getByText('Security review')).toBeVisible();
expect(screen.queryByText('Finished audit')).toBeNull();
await user.click(screen.getByRole('button', { name: 'Completed · 1' }));
expect(screen.getByText('Finished audit')).toBeVisible();
```

- [ ] **Step 2: Write failing persisted-tab migration tests**

Require `agents` to round-trip, legacy `child-workspaces` to map to `agents` and rewrite local storage through `loadPersistedTopPanelState`, existing change-tab migrations to remain intact, and unknown values to fall back to `changes`.

- [ ] **Step 3: Write failing query and invalidation tests**

Require no query while the panel is hidden or the selected session has not hydrated; one parent-scoped query when ready; disconnect/reconnect of the same selected session to refetch the authoritative list; a null render for `{ supported: false }`; session-matching browser invalidation to refetch; and another session's event to leave the query untouched.

```typescript
expect(listSubagentsQuery).toHaveBeenCalledWith(
  { sessionId: 'session-1', cursor: null, limit: 100 },
  expect.objectContaining({ enabled: true })
);
dispatchSubagentChange({
  sessionId: 'session-1',
  subagentId: 'child-1',
  change: 'updated',
});
expect(invalidate).toHaveBeenCalledTimes(1);
```

- [ ] **Step 4: Write failing Agents composition and right-panel tests**

Require the tab label to be `Agents` for both parent and child workspaces. When active, require the provider section to receive only the selected session while the child-workspace section receives only the workspace ID. Require child workspaces to render for eligible parents, remain absent for child workspaces, and remain unchanged when the selected session changes.

- [ ] **Step 5: Run list, query, composition, and state tests and verify RED**

```bash
pnpm exec vitest run src/client/features/subagents/subagent-list.test.tsx src/client/features/subagents/provider-subagents-section.test.tsx src/client/features/workspace/agents-panel.test.tsx src/client/features/workspace/right-panel-state.test.ts src/client/features/workspace/right-panel.test.tsx
```

Expected: FAIL because the subagents feature and Agents tab state do not exist.

- [ ] **Step 6: Implement the presentational list and stories**

Keep data fetching outside `SubagentList`. Its public props are explicit:

```typescript
type SubagentListProps = {
  state:
    | { kind: 'loading' }
    | { kind: 'unsupported' }
    | { kind: 'error'; message: string; onRetry: () => void }
    | { kind: 'ready'; subagents: SubagentSummary[] };
  selectedSubagentId?: string | null;
  onSelect: (subagent: SubagentSummary) => void;
};
```

Stories must cover empty, active-only, mixed with collapsed completion, expanded completion, loading, unsupported, and list error at a 320 px panel width.

- [ ] **Step 7: Implement query ownership and live invalidation**

`ProviderSubagentsSection` calls `session.listSubagents` only when the Agents tab is visible, `sessionId` exists, and the parent session has hydrated. A readiness transition from disconnected to hydrated invalidates the selected session's list before enabling it. Subscribe to the browser event and invalidate only matching parent-session list queries. Return `null` for unsupported providers so the Sub-agents section is absent. Keep completed expansion state local to the selected session.

- [ ] **Step 8: Compose the Agents panel and migrate persisted state**

Rename the internal top-tab key to `agents`, always show the Agents tab so child workspaces can inspect provider sub-agents, and render the Child Workspaces section only when `isParentWorkspace` is true. Add an `embedded` presentation prop to `ChildWorkspacesPanel` so both sections share one vertical scroll container without changing its dialog or links.

```tsx
<AgentsPanel
  workspaceId={workspaceId}
  sessionId={selectedSessionId}
  sessionReady={selectedSessionReady}
  isParentWorkspace={isParentWorkspace}
  onOpenSubagent={onOpenSubagent}
/>
```

- [ ] **Step 9: Run list, query, migration, composition, and boundary tests and verify GREEN**

```bash
pnpm exec vitest run src/client/features/subagents/subagent-list.test.tsx src/client/features/subagents/provider-subagents-section.test.tsx src/client/features/workspace/agents-panel.test.tsx src/client/features/workspace/right-panel-state.test.ts src/client/features/workspace/right-panel.test.tsx src/client/features/workspace/workspace-panel-context.test.tsx
pnpm deps:check
```

Expected: list states, sorting, collapse, migration, and dependency boundaries pass. The `workspace` feature imports subagents only from `@/client/features/subagents`.

- [ ] **Step 10: Commit the Agents panel**

```bash
git add src/client/features/subagents src/client/features/workspace
git commit -m "Add session-scoped sub-agents to Agents panel"
```

### Task 8: Add Read-Only Transcript Drill-In Without Replacing the Parent Session

**Files:**
- Create: `src/client/features/subagents/subagent-transcript-content.tsx`
- Create: `src/client/features/subagents/subagent-transcript-view.tsx`
- Create: `src/client/features/subagents/subagent-transcript-view.test.tsx`
- Create: `src/client/features/subagents/subagent-transcript-view.stories.tsx`
- Modify: `src/client/features/subagents/index.ts`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-view.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-view.test.tsx`

**Interfaces:**
- Produces: `SubagentTranscriptView({ selection, onBack, workspaceId })`
- Produces: presentational `SubagentTranscriptContent` for Storybook and component tests
- Consumes: Task 5 read query/invalidation and Task 6 transcript projector

- [ ] **Step 1: Write failing transcript view tests**

Require breadcrumb parent/child names, `Read only` badge, exact terminal status, and no textarea, composer, permission, stop, steering, close, or archive controls. Cover Back callback, loading, empty, unavailable with retained preview, initial newest-page projection, and Load older prepending without losing the current viewport.

```typescript
expect(screen.getByText('Session 1')).toBeVisible();
expect(screen.getByText('Security review')).toBeVisible();
expect(screen.getByText('Read only')).toBeVisible();
expect(document.querySelector('textarea')).toBeNull();
```

- [ ] **Step 2: Write failing workspace drill-in tests**

Update the RightPanel mock so it can call `onOpenSubagent`. Require the parent ChatContent DOM node to remain mounted but hidden, the session tab selection prop to remain unchanged, the transcript to appear, Back to restore the same parent node, and changing `selectedDbSessionId` to clear the drill-in.

- [ ] **Step 3: Run transcript and workspace tests and verify RED**

```bash
pnpm exec vitest run src/client/features/subagents/subagent-transcript-view.test.tsx src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
```

Expected: FAIL because no transcript component or drill-in selection state exists.

- [ ] **Step 4: Implement paginated read-only transcript data flow**

Use `session.readSubagentTranscript.useInfiniteQuery` with `limit: 10`. The first page contains newest turns; subsequent pages are older. Reverse page order before flattening updates, then call `projectAcpTranscriptUpdates`.

```typescript
const updates = [...query.data.pages]
  .reverse()
  .flatMap((page) => page.updates);
const messages = projectAcpTranscriptUpdates(updates);
```

Subscribe to matching sub-agent invalidations and refetch active transcript pages. Preserve scroll position when older pages prepend by recording `scrollHeight - scrollTop` before fetch and restoring that distance after render.

- [ ] **Step 5: Implement the read-only presentation and stories**

Render the breadcrumb, status badge, result preview fallback, Back button, grouped existing message renderers, Load older control, and contained error/retry states. Stories must cover active/live, completed, failed, empty, loading, and transcript unavailable at desktop and narrow widths.

- [ ] **Step 6: Keep the parent chat mounted during route-level drill-in**

Add local selection state to `WorkspaceDetailView`. Pass selected session readiness from the container (`runtimeSessionId === selectedDbSessionId && connected`) to RightPanel. Render chat and transcript as siblings:

```tsx
<div className={cn('h-full', selectedSubagent && 'hidden')}>
  <ChatContent {...chat} />
</div>
{selectedSubagent && (
  <SubagentTranscriptView
    workspaceId={workspaceState.workspaceId}
    selection={selectedSubagent}
    onBack={() => setSelectedSubagent(null)}
  />
)}
```

Reset selection when workspace ID or selected parent session ID changes. Do not add a main-view tab or mutate `selectedDbSessionId` when a child opens.

- [ ] **Step 7: Run transcript and workspace tests and verify GREEN**

```bash
pnpm exec vitest run src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/chat/project-acp-transcript.test.ts src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
pnpm deps:check
```

Expected: all read-only, pagination, unavailable, Back, session reset, scroll preservation, and feature-boundary tests pass.

- [ ] **Step 8: Commit read-only drill-in**

```bash
git add src/client/features/subagents src/client/routes/projects/workspaces
git commit -m "Add read-only sub-agent transcript drill-in"
```

### Task 9: Verify Real Codex Recovery, Visual States, and Documentation

**Files:**
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.manual.integration.test.ts`
- Modify: `AGENTS.md`
- Review: all files changed by Tasks 1-8

**Interfaces:**
- Consumes: complete provider-neutral contract, Codex adapter, runtime transport, and client UI
- Produces: one opt-in real Codex sub-agent scenario and current repository feature documentation

- [ ] **Step 1: Extend the manual connection and write the real Codex scenario**

Add `extNotification` recording to the manual connection. Under `RUN_REAL_CODEX_APP_SERVER_PROMPT_TESTS=1`, start a Codex session with a prompt that explicitly spawns one bounded research sub-agent and waits for it. Require at least one namespaced tool update, list the child, read a non-empty transcript, and repeat list/read after closing and loading a fresh adapter for the same provider session ID.

```typescript
expect(recordedUpdates.some(hasFactoryFactorySubagentMeta)).toBe(true);
expect(list.subagents.length).toBeGreaterThan(0);
expect(read.updates.length).toBeGreaterThan(0);
expect(reloadedList.subagents.map((item) => item.id)).toContain(list.subagents[0]!.id);
```

Keep this scenario opt-in because it requires local Codex authentication and consumes tokens.

- [ ] **Step 2: Update the feature note**

Add a separate AGENTS.md bullet stating that provider-initiated sub-agents are session-scoped, read-only, provider-owned, surfaced through `factoryfactory.ai` ACP extensions, shown in the Agents panel, and distinct from child workspaces.

- [ ] **Step 3: Run all focused feature tests**

```bash
pnpm exec vitest run src/shared/acp-protocol/subagents.test.ts src/shared/acp-protocol/session-update-translator.test.ts src/backend/services/session/service/acp/acp-client-handler.test.ts src/backend/services/session/service/acp/acp-process-handle.test.ts src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-mapper.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-subagent-controller.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts src/backend/services/session/service/lifecycle/acp-event-processor.subagents.test.ts src/backend/trpc/session.router.test.ts src/client/features/chat/project-acp-transcript.test.ts src/client/features/chat/use-chat-transport.test.ts src/client/features/subagents/subagent-list.test.tsx src/client/features/subagents/provider-subagents-section.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/workspace/agents-panel.test.tsx src/client/features/workspace/right-panel-state.test.ts src/client/features/workspace/right-panel.test.tsx src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
```

Expected: every listed file passes with zero failed tests.

- [ ] **Step 4: Run repository guardrails**

```bash
pnpm check:fix
pnpm typecheck
pnpm check
pnpm test
pnpm build
pnpm build:storybook
```

Expected: all six commands exit zero. Inspect and fix every reproducible failure, then rerun the failed command and its affected focused tests.

- [ ] **Step 5: Perform visual QA**

```bash
pnpm storybook
```

Inspect the sub-agent list and transcript stories at 320 px, 768 px, and desktop widths in light and dark themes. Verify active status motion, collapsed completed content, truncation, focus order, keyboard expansion, Back navigation, error copy, scroll containment, and that no composer appears in transcript stories. Capture review screenshots if the implementation workflow requires PR evidence.

- [ ] **Step 6: Run the opt-in Codex scenario when authenticated**

```bash
pnpm test:codex-app-server:manual:prompt
```

Expected: the real app-server prompt, live metadata, parent-filtered list, transcript read, and restart recovery assertions pass. If the environment lacks Codex authentication, record this one check as not run and keep all deterministic adapter tests green.

- [ ] **Step 7: Exercise the real in-app lifecycle when authenticated**

```bash
pnpm dev
```

In a Codex parent session, request one bounded sub-agent and wait for it. Open Agents and verify the live row and parent tool call, open the read-only child transcript while it is updating, use Back and confirm the parent's exact scroll position, observe the terminal row move beneath collapsed `Completed · 1`, expand and reopen it, restart Factory Factory, reload the same parent session, and inspect the completed transcript again. Also switch parent sessions and confirm the sub-agent list and any open drill-in reset while Child workspaces remain workspace-scoped. Record screenshots or a short result note for PR evidence. If local provider authentication is unavailable, record this manual scenario as not run rather than weakening deterministic coverage.

- [ ] **Step 8: Review the full diff and confirm persistence boundaries**

```bash
git diff origin/main -- prisma src/backend src/client src/shared AGENTS.md docs/superpowers
git status --short
```

Expected: no Prisma schema/migration, workspace snapshot, export, or backup file changed; provider branches exist only inside adapter code; `.superpowers/brainstorm/` remains uncommitted or ignored.

- [ ] **Step 9: Commit verification documentation**

```bash
git add AGENTS.md src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.manual.integration.test.ts
git commit -m "Document and verify provider sub-agents"
```

The feature is ready for code review when deterministic verification passes, Storybook states have been inspected, the optional real-provider result is recorded, and `git status --short` contains no unexpected implementation files.
