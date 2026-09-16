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
    `use the \`send_message_to_parent\` tool to report back. Include a brief summary of what was done and any next steps the parent workspace should be aware of.`;
  if (reportBackOn) {
    context += `\nReport back when: ${reportBackOn}`;
  }
  return `${context}\n`;
}
