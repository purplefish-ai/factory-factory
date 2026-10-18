import { performance } from 'node:perf_hooks';
import {
  baselineRevision,
  projectAcpTranscriptUpdates as projectBaselineTranscript,
} from 'virtual:subagent-transcript-baseline';
import { expect, test } from 'vitest';
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

function measureProjection(
  project: typeof projectAcpTranscriptUpdates,
  updates: SubagentTranscriptUpdate[],
  samples: number[]
) {
  const start = performance.now();
  const messages = project(updates);
  samples.push(performance.now() - start);
  return messages;
}

function median(samples: number[]): number | undefined {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
}

test('compare baseline and current mixed subagent transcript projection', () => {
  for (const toolsPerTurn of [5, 25, 100]) {
    const updates = createUpdates(toolsPerTurn);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      projectBaselineTranscript(updates);
      projectAcpTranscriptUpdates(updates);
    }
    const baselineSamples: number[] = [];
    const currentSamples: number[] = [];
    let first = { project: projectBaselineTranscript, samples: baselineSamples };
    let second = { project: projectAcpTranscriptUpdates, samples: currentSamples };
    for (let iteration = 0; iteration < 15; iteration += 1) {
      const firstMessages = measureProjection(first.project, updates, first.samples);
      const secondMessages = measureProjection(second.project, updates, second.samples);
      // Check complete output outside the timed region, not just its length.
      expect(firstMessages).toEqual(secondMessages);
      expect(firstMessages).toHaveLength(10 + 30 * toolsPerTurn);
      [first, second] = [second, first];
    }
    console.log(
      JSON.stringify({
        baselineRevision,
        toolsPerTurn,
        updates: updates.length,
        warmupPairs: 3,
        measuredPairs: 15,
        baselineMedianMs: median(baselineSamples),
        currentMedianMs: median(currentSamples),
        baselineSamples,
        currentSamples,
      })
    );
  }
});
