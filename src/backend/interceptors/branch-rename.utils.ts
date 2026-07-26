import type { ValidationLogger } from '@/backend/schemas/tool-inputs.schema';
import { extractInputValue, isString } from '@/backend/schemas/tool-inputs.schema';
import type { ToolEvent } from './types';

/**
 * Generate a branch name from workspace context.
 *
 * Kebab-cases the workspace name and optionally prepends a prefix.
 * Result is capped at 60 characters (prefix + slash + name).
 */
export function generateBranchName(context: {
  branchPrefix: string;
  workspaceName: string;
}): string {
  const slug = context.workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

  if (!slug) {
    return '';
  }

  if (context.branchPrefix) {
    return `${context.branchPrefix}/${slug}`;
  }
  return slug;
}

export function extractMatchingCommands(
  event: ToolEvent,
  commandRegex: RegExp,
  logger?: ValidationLogger
): string[] {
  const command = extractInputValue(event.input, 'command', isString, event.toolName, logger);
  const cmd = extractInputValue(event.input, 'cmd', isString, event.toolName, logger);
  const title = extractInputValue(event.input, 'title', isString, event.toolName, logger);

  return [command, cmd, title, event.toolName].filter(
    (candidate): candidate is string => candidate !== undefined && commandRegex.test(candidate)
  );
}
