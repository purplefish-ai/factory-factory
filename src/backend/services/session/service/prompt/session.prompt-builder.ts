export function buildChildWorkspaceContext(input: {
  parentWorkspaceName?: string | null;
  parentProjectName?: string | null;
  reportBackOn?: string | null;
}): string {
  const parentName = input.parentWorkspaceName ?? 'unknown';
  const projectName = input.parentProjectName ?? 'unknown project';
  const reportBackOn = input.reportBackOn?.trim();
  let context =
    `## Child Workspace Context\n` +
    `You are working in a child workspace created by the parent workspace "${parentName}" (project: ${projectName}). ` +
    `When you have completed your task or reached a significant milestone — especially if you produced a PR, a finding, or are blocked — ` +
    `use the \`send_message_to_parent\` tool to report back. Include a brief summary of what was done and any next steps the parent workspace should be aware of. ` +
    `Workspace correspondence is stored in your inbox. Use \`list_mail\` for bounded summaries, \`read_mail\` for selected messages, and \`ack_mail\` with the observed revision after inspection. Acknowledging mail does not complete its task. ` +
    `Send routine status using kind PROGRESS with a stable taskKey; use BLOCKER, QUESTION, or COMPLETION for actionable updates. ` +
    `When waiting only for mail or CI, end your turn so queued signals can be delivered; do not poll the inbox in a loop.`;
  if (reportBackOn) {
    context += `\nReport back when: ${reportBackOn}`;
  }
  return `${context}\n`;
}
