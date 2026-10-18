import { performance } from 'node:perf_hooks';
import { test } from 'vitest';
import { projectAcpTranscriptUpdates } from '../src/client/features/chat/project-acp-transcript';
import type { SubagentTranscriptUpdate } from '../src/shared/acp-protocol/subagents';

// Run with pnpm exec vitest run --config scripts/bench-subagent-transcript.config.ts.
// Keep this fixture fixed when comparing revisions: ten turns, pending/completed
// calls with 512-byte outputs, and an assistant text chunk after each tool.
function createUpdates(toolsPerTurn: number): SubagentTranscriptUpdate[] {
  const updates: SubagentTranscriptUpdate[] = [];
  for (let turn = 0; turn < 10; turn += 1) {
    updates.push({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `Turn ${turn}` },
    });
    for (let tool = 0; tool < toolsPerTurn; tool += 1) {
      const toolCallId = `tool-${turn}-${tool}`;
      updates.push(
        {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Read',
          kind: 'read',
          status: 'pending',
          rawInput: { path: `src/${tool}.ts` },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: 'x'.repeat(512),
        },
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Read ${tool}. Next.` },
        }
      );
    }
  }
  return updates;
}

test('measure mixed subagent transcript projection', () => {
  for (const toolsPerTurn of [5, 25, 100]) {
    const updates = createUpdates(toolsPerTurn);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      projectAcpTranscriptUpdates(updates);
    }
    const samples: number[] = [];
    for (let iteration = 0; iteration < 9; iteration += 1) {
      const start = performance.now();
      const messages = projectAcpTranscriptUpdates(updates);
      samples.push(performance.now() - start);
      if (messages.length !== 10 + 30 * toolsPerTurn) {
        throw new Error(`Unexpected projected message count: ${messages.length}`);
      }
    }
    const sorted = [...samples].sort((left, right) => left - right);
    console.log(
      JSON.stringify({ toolsPerTurn, updates: updates.length, medianMs: sorted[4], samples })
    );
  }
});
