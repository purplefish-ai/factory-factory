# Claude Transcript Whitespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove blank padded rows created by Claude usage telemetry while preserving usage statistics, visible string results, and tool-call pairing.

**Architecture:** Keep all ACP usage messages in persisted transcript and reducer state. Filter result messages that have no non-empty string content at the shared `groupAdjacentToolCalls` rendering boundary before they can split tool sequences or become virtual rows.

**Tech Stack:** TypeScript, Vitest, React chat protocol helpers

## Global Constraints

- Apply the behavior to every transcript surface through the existing shared grouping helper.
- Preserve object-valued usage results in reducer and persisted transcript state.
- Preserve non-empty string result rendering.
- Preserve matching tool-use/tool-result pairing when usage telemetry occurs between them.
- Do not change backend protocols, persistence, database schemas, or provider-specific branches.

---

### Task 1: Filter Non-Renderable Result Rows

**Files:**
- Modify: `src/lib/chat-protocol.ts:695`
- Test: `src/lib/chat-protocol.test.ts:232`

**Interfaces:**
- Consumes: `ChatMessage`, `GroupedMessageItem`, and the existing `groupAdjacentToolCalls(messages: ChatMessage[]): GroupedMessageItem[]` API.
- Produces: unchanged `groupAdjacentToolCalls` signature with non-renderable result messages omitted from its returned rendering items.

- [x] **Step 1: Add failing regression tests**

Add a local fixture for result messages:

```ts
function createResultMessage(result: unknown, order: number): ChatMessage {
  return {
    id: `msg-${order}`,
    source: 'agent',
    message: { type: 'result', result },
    timestamp: '2026-02-16T00:00:00.000Z',
    order,
  };
}
```

Add three behaviors under `describe('groupAdjacentToolCalls')`:

```ts
it.each([
  ['object-valued usage', { sessionUpdate: 'usage_update', used: 15_000 }],
  ['empty string', ''],
  ['whitespace-only string', '   '],
])('omits %s results from rendering output', (_label, result) => {
  const assistant = createAssistantTextMessage(2);
  const grouped = groupAdjacentToolCalls([
    createAssistantTextMessage(0),
    createResultMessage(result, 1),
    assistant,
  ]);

  expect(grouped).toEqual([createAssistantTextMessage(0), assistant]);
});

it('keeps non-empty string result messages in rendering output', () => {
  const result = createResultMessage('Completed successfully', 0);
  expect(groupAdjacentToolCalls([result])).toEqual([result]);
});

it('does not let usage results split matching tool calls and results', () => {
  const grouped = groupAdjacentToolCalls([
    createToolUseMessage({ id: 'call-1', name: 'Read', input: {}, order: 0 }),
    createResultMessage({ sessionUpdate: 'usage_update', used: 15_000 }, 1),
    createToolResultMessage('call-1', 2),
  ]);

  expect(grouped).toHaveLength(1);
  expect(isToolSequence(grouped[0]!)).toBe(true);
  if (isToolSequence(grouped[0]!)) {
    expect(grouped[0].pairedCalls[0]).toMatchObject({
      id: 'call-1',
      status: 'success',
      result: { content: 'ok', isError: false },
    });
  }
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/lib/chat-protocol.test.ts`

Expected: the non-renderable result cases fail because each result is returned as a grouped item,
and the tool-pairing test fails because telemetry splits the adjacent sequence.

- [x] **Step 3: Add the minimal rendering predicate and filter**

Add a private helper near the grouping code:

```ts
function isRenderableGroupedMessage(message: ChatMessage): boolean {
  return (
    message.source !== 'agent' ||
    message.message?.type !== 'result' ||
    (typeof message.message.result === 'string' && message.message.result.trim().length > 0)
  );
}
```

At the start of the `groupAdjacentToolCalls` loop, skip these messages before late-tool-result and sequence-boundary processing:

```ts
for (const message of messages.filter(isRenderableGroupedMessage)) {
  // existing grouping logic
}
```

- [x] **Step 4: Run focused and related tests and verify GREEN**

Run:

```bash
pnpm test src/lib/chat-protocol.test.ts src/client/features/chat/project-acp-transcript.test.ts src/client/features/chat/agent-activity/message-renderers/assistant-message-renderer.test.tsx
```

Expected: all selected test files pass with no errors or warnings.

- [x] **Step 5: Run repository verification**

Run:

```bash
pnpm typecheck
pnpm check
pnpm test
```

Expected: every command exits successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/lib/chat-protocol.ts src/lib/chat-protocol.test.ts docs/superpowers/plans/2026-08-10-claude-transcript-whitespace.md
git commit -m "Fix blank rows in Claude transcripts"
```

- [ ] **Step 7: Publish the requested draft PR**

Confirm the final diff contains only the design, plan, test, and implementation files. Push the current feature branch and open a draft pull request describing the Claude usage-event root cause and verification commands.
