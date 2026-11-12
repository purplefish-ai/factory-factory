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

it('states that event automations run once the user enables them', () => {
  expect(AUTOMATION_AUTHORING_TOOLS.map((tool) => tool.name)).toEqual([
    'list_automation_sources',
    'propose_automation',
    'get_automation_proposal',
  ]);
  for (const tool of AUTOMATION_AUTHORING_TOOLS) {
    expect(tool.description, tool.name).not.toMatch(/execution is not available/i);
  }
  for (const name of ['list_automation_sources', 'propose_automation']) {
    const description = AUTOMATION_AUTHORING_TOOLS.find((tool) => tool.name === name)?.description;
    expect(description, name).toMatch(/start(s)? paused/);
    expect(description, name).toContain('only the user enables');
    expect(description, name).toContain('from the Automations page');
    expect(description, name).toContain('GitHub labeled and reopened triggers');
    expect(description, name).toContain(
      'Slack triggers run only when Slack event intake is turned on'
    );
  }
});
