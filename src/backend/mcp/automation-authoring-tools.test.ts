import { expect, it } from 'vitest';
import { agentGithubExecutableActions } from '@/shared/agent-runtime';
import { AUTOMATION_AUTHORING_TOOLS } from './automation-authoring-tools';

// Saved triggers may still list these, but they report UNSUPPORTED_GITHUB_ACTION.
const unsupportedGithubActions = /\b(opened|edited)\b/;

it('advises only GitHub issue actions that can be enabled', () => {
  for (const tool of AUTOMATION_AUTHORING_TOOLS) {
    for (const sentence of tool.description.split(/(?<=\.)\s+/)) {
      if (unsupportedGithubActions.test(sentence)) {
        expect(sentence, tool.name).toMatch(/not yet supported/);
      }
    }
  }
  const propose = AUTOMATION_AUTHORING_TOOLS.find((tool) => tool.name === 'propose_automation');
  expect(propose?.description).toContain(
    `choose actions only from ${agentGithubExecutableActions.join(' and ')};`
  );
  // Labels applied at creation arrive as labeled events, so opened is never needed for them.
  expect(propose?.description).toContain(
    'labeled also covers labels applied when an issue is created'
  );
  expect(propose?.description).toContain('The opened and edited actions are not yet supported');
});
