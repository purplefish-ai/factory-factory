/**
 * Branch Rename Interceptor
 *
 * Monitors tool executions for `git branch -m` or `git branch -M` commands
 * and updates the workspace with the new branch name when detected.
 */

import { gitCommand } from '@/backend/lib/shell';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';
import { extractMatchingCommand } from './branch-rename.utils';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('branch-rename');
const GIT_BRANCH_RENAME_TEXT_REGEX = /\bgit\s+branch\s+-[mM]\b/;
const GIT_BRANCH_RENAME_COMMAND_REGEX = /(?:^|&&|\|\||[;&|\n(])\s*git\s+branch\s+-[mM]\b/;
const SHELL_COMMAND_PAYLOAD_REGEX =
  /(?:^|&&|\|\||[;&|\n(])\s*(?:\/(?:usr\/)?bin\/)?(?:ba)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+\uE000(\d+)\uE001/g;

interface MaskedShellCommand {
  command: string;
  quotedArguments: string[];
}

interface QuotedArgument {
  endIndex: number;
  value: string;
}

function readQuotedArgument(command: string, startIndex: number): QuotedArgument {
  const quote = command.charAt(startIndex);
  let value = '';
  let endIndex = startIndex + 1;

  while (endIndex < command.length && command[endIndex] !== quote) {
    const character = command.charAt(endIndex);
    if (quote === '"' && character === '\\' && endIndex + 1 < command.length) {
      const escapedCharacter = command.charAt(endIndex + 1);
      if (escapedCharacter !== '\n') {
        value += /["\\$`]/.test(escapedCharacter) ? escapedCharacter : character + escapedCharacter;
      }
      endIndex += 2;
      continue;
    }
    value += character;
    endIndex += 1;
  }

  return { endIndex, value };
}

function findShellCommentEnd(command: string, startIndex: number): number {
  const newlineIndex = command.indexOf('\n', startIndex);
  return newlineIndex === -1 ? command.length : newlineIndex;
}

function maskQuotedArgumentsAndComments(command: string): MaskedShellCommand {
  let maskedCommand = '';
  const quotedArguments: string[] = [];
  let atWordStart = true;

  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);

    if (character === '#' && atWordStart) {
      index = findShellCommentEnd(command, index);
      if (index < command.length) {
        maskedCommand += '\n';
      }
      atWordStart = true;
      continue;
    }

    if (character === "'" || character === '"') {
      const quotedArgument = readQuotedArgument(command, index);
      index = quotedArgument.endIndex;
      const quotedArgumentIndex = quotedArguments.push(quotedArgument.value) - 1;
      maskedCommand += `\uE000${quotedArgumentIndex}\uE001`;
      atWordStart = false;
      continue;
    }

    if (character === '\\' && index + 1 < command.length) {
      maskedCommand += '  ';
      index += 1;
      atWordStart = false;
      continue;
    }

    maskedCommand += character;
    atWordStart = /[\s;&|()]/.test(character);
  }

  return { command: maskedCommand, quotedArguments };
}

function containsGitBranchRenameCommand(command: string): boolean {
  const masked = maskQuotedArgumentsAndComments(command);
  if (GIT_BRANCH_RENAME_COMMAND_REGEX.test(masked.command)) {
    return true;
  }

  for (const match of masked.command.matchAll(SHELL_COMMAND_PAYLOAD_REGEX)) {
    const payload = masked.quotedArguments[Number(match[1])];
    if (payload !== undefined && containsGitBranchRenameCommand(payload)) {
      return true;
    }
  }

  return false;
}

export const branchRenameInterceptor: ToolInterceptor = {
  name: 'branch-rename',
  tools: '*',

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    // Skip if tool execution failed
    if (event.output?.isError) {
      return;
    }

    // Check if this was a `git branch -m` or `git branch -M` command (branch rename)
    // -m: rename branch, -M: force rename (overwrite if target exists)
    // Use regex to avoid false positives from strings containing "git branch -m"
    const command = extractMatchingCommand(event, GIT_BRANCH_RENAME_TEXT_REGEX, logger);
    if (!(command && containsGitBranchRenameCommand(command))) {
      return;
    }
    workspaceGitStateService.invalidate(context.workingDir);

    logger.info('Detected git branch rename command', {
      workspaceId: context.workspaceId,
      command,
    });

    // Get the current branch name from the worktree
    const result = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], context.workingDir);
    if (result.code !== 0) {
      logger.warn('Failed to get current branch after rename', {
        workspaceId: context.workspaceId,
        stderr: result.stderr,
      });
      return;
    }

    const newBranchName = result.stdout.trim();
    if (!newBranchName) {
      logger.warn('Empty branch name returned after rename', {
        workspaceId: context.workspaceId,
      });
      return;
    }

    // Update the workspace with the new branch name and mark it as agent-chosen.
    await workspaceDataService.setBranchNameAndClearAutoGenerated(
      context.workspaceId,
      newBranchName
    );

    logger.info('Updated workspace with new branch name', {
      workspaceId: context.workspaceId,
      newBranchName,
    });
  },
};
