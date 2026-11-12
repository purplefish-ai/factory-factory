import { expect, it } from 'vitest';
import type { AgentTriggerInput } from '@/shared/schemas/agent-definition.schema';
import { triggerCapability } from './agent-management-projection';

type GithubAction = Extract<
  AgentTriggerInput,
  { type: 'GITHUB_ISSUE' }
>['config']['actions'][number];
const github = (actions: GithubAction[]): AgentTriggerInput => ({
  type: 'GITHUB_ISSUE',
  description: 'Issues',
  isEnabled: false,
  filterInstructions: null,
  connectionId: 'connection',
  config: { version: 1, repositoryIds: ['repo'], actions },
});

it.each<{ actions: GithubAction[] }>([
  { actions: ['labeled'] },
  { actions: ['reopened'] },
  { actions: ['labeled', 'reopened'] },
])('supports GitHub $actions triggers', ({ actions }) => {
  expect(triggerCapability(github(actions), true)).toMatchObject({ status: 'SUPPORTED' });
});

it.each<{ actions: GithubAction[] }>([
  { actions: ['opened'] },
  { actions: ['edited'] },
  { actions: ['opened', 'reopened'] },
  { actions: ['labeled', 'edited'] },
])('keeps GitHub $actions triggers unsupported', ({ actions }) => {
  expect(triggerCapability(github(actions), true)).toEqual({
    status: 'UNSUPPORTED',
    reasonCode: 'UNSUPPORTED_GITHUB_ACTION',
    explanation: 'Only GitHub labeled and reopened events are supported.',
  });
});
