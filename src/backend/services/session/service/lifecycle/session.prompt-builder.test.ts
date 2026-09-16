import { describe, expect, it } from 'vitest';
import { buildChildWorkspaceContext } from './session.prompt-builder';

describe('buildChildWorkspaceContext', () => {
  it('builds the exact child context with parent details and report-back criteria', () => {
    expect(
      buildChildWorkspaceContext({
        parentWorkspaceName: 'parent-workspace',
        parentProjectName: 'parent-project',
        reportBackOn: 'a PR is opened',
      })
    ).toBe(
      `## Child Workspace Context\n` +
        `You are working in a child workspace created by the parent workspace "parent-workspace" (project: parent-project). ` +
        `When you have completed your task or reached a significant milestone — especially if you produced a PR, a finding, or are blocked — ` +
        `use the \`send_message_to_parent\` tool to report back. Include a brief summary of what was done and any next steps the parent workspace should be aware of.\n` +
        `Report back when: a PR is opened\n`
    );
  });

  it('uses parent-name fallbacks and omits absent report-back criteria', () => {
    expect(
      buildChildWorkspaceContext({
        parentWorkspaceName: null,
        parentProjectName: null,
      })
    ).toBe(
      `## Child Workspace Context\n` +
        `You are working in a child workspace created by the parent workspace "unknown" (project: unknown project). ` +
        `When you have completed your task or reached a significant milestone — especially if you produced a PR, a finding, or are blocked — ` +
        `use the \`send_message_to_parent\` tool to report back. Include a brief summary of what was done and any next steps the parent workspace should be aware of.\n`
    );
  });

  it('omits whitespace-only report-back criteria', () => {
    const context = buildChildWorkspaceContext({ reportBackOn: '  \n\t' });

    expect(context).not.toContain('Report back when:');
  });

  it('trims surrounding whitespace from report-back criteria', () => {
    const context = buildChildWorkspaceContext({ reportBackOn: '  a PR is opened  ' });

    expect(context).toContain('\nReport back when: a PR is opened\n');
    expect(context).not.toContain('  a PR is opened  ');
  });
});
