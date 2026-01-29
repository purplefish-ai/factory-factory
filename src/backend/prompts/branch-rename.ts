/**
 * Branch rename instruction builder.
 *
 * Generates system instructions telling Claude to rename auto-generated branches
 * to meaningful names based on the workspace context.
 */

export interface BranchRenameContext {
  /** Current auto-generated branch name (e.g., "martin-purplefish/a38djnb") */
  currentBranchName: string;
  /** Prefix to use for the new branch (e.g., "martin-purplefish") */
  branchPrefix: string;
  /** Workspace name/title */
  workspaceName: string;
  /** Optional workspace description */
  workspaceDescription?: string;
}

/**
 * Build system instructions for renaming an auto-generated branch.
 */
export function buildBranchRenameInstruction(context: BranchRenameContext): string {
  const prefixPart = context.branchPrefix
    ? `Use the prefix "${context.branchPrefix}/" before the name.`
    : '';

  const contextLines = [`- Workspace: ${context.workspaceName}`];
  if (context.workspaceDescription) {
    contextLines.push(`- Description: ${context.workspaceDescription}`);
  }

  return `<system_instruction>
Use \`git branch -m\` to rename the branch.

Do this immediately, before using any skills or any other tools. Do not check the current branch name, just rename it.

Choosing a branch name: use concrete, specific language, avoid abstract nouns, and be concise (<30 characters). ${prefixPart}

Context for naming:
${contextLines.join('\n')}
</system_instruction>

`;
}
