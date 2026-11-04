import { describe, expect, it } from 'vitest';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { buildWorkspaceSessionSummaries } from './session-summaries';

const runtime: SessionRuntimeState = {
  phase: 'running',
  processState: 'alive',
  activity: 'WORKING',
  updatedAt: '2026-11-04T00:00:00.000Z',
};

function session(id: string) {
  return { id, name: id, workflow: 'followup', model: 'opus', status: 'RUNNING' as const };
}

describe('buildWorkspaceSessionSummaries', () => {
  it('reports each session’s own pending request type', () => {
    const summaries = buildWorkspaceSessionSummaries(
      [session('plan'), session('question'), session('permission'), session('free')],
      () => runtime,
      new Map([
        ['plan', { toolName: 'ExitPlanMode', input: {} }],
        [
          'question',
          {
            toolName: 'AskUserQuestion',
            input: { questions: [{ question: 'Which branch?', options: [] }] },
          },
        ],
        ['permission', { toolName: 'Bash', input: { command: 'pnpm test' } }],
        ['other-workspace-session', { toolName: 'ExitPlanMode', input: {} }],
      ])
    );

    expect(summaries.map((summary) => [summary.sessionId, summary.pendingRequestType])).toEqual([
      ['plan', 'plan_approval'],
      ['question', 'user_question'],
      ['permission', 'permission_request'],
      ['free', null],
    ]);
  });

  it('keeps runtime fields alongside the pending request', () => {
    const [summary] = buildWorkspaceSessionSummaries([session('s-1')], () => runtime, new Map());

    expect(summary).toMatchObject({
      sessionId: 's-1',
      runtimePhase: 'running',
      activity: 'WORKING',
      lastExit: null,
      errorMessage: null,
      pendingRequestType: null,
    });
  });
});
