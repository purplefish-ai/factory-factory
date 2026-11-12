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
  expect(propose?.description).toContain('The opened and edited actions are not yet supported');
});
