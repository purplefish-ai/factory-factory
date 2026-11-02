import type { PairedToolCall } from '@/lib/chat-protocol';
import { compactCommandLabel } from './compact-command-label';
import { isCodexFileChangeToolName } from './file-change-parser';
import {
  extractCommandPreviewFromInput,
  getDisplayToolName,
  isRunLikeToolName,
  normalizeWhitespace,
  RUN_COMMAND_PREVIEW_MAX,
  truncateWithEllipsis,
} from './tool-display-utils';
import { isWebSearchToolName } from './web-search-parser';

export type ToolActivityKind = 'command' | 'edit' | 'read' | 'search' | 'other';
const VERBS = {
  command: { pending: 'Running', error: 'Failed', success: 'Ran' },
  edit: { pending: 'Editing', error: 'Failed to edit', success: 'Edited' },
  read: { pending: 'Reading', error: 'Failed to read', success: 'Read' },
};

export function getToolActivityKind(name: string): ToolActivityKind {
  if (
    isRunLikeToolName(name) ||
    /^(bash|shell|terminal|exec_command|execute_command)$/i.test(name.trim())
  ) {
    return 'command';
  }
  if (
    isCodexFileChangeToolName(name) ||
    /^(edit|write|multiedit|apply_patch)$/i.test(name.trim())
  ) {
    return 'edit';
  }
  if (/^(read|readfile|read_file)(\s|$)/i.test(name.trim())) {
    return 'read';
  }
  if (isWebSearchToolName(name) || /^(grep|glob|search)(\s|$)/i.test(name.trim())) {
    return 'search';
  }
  return 'other';
}

function commandPreview(call: PairedToolCall): string {
  const command = extractCommandPreviewFromInput(call.input);
  if (command) {
    return command;
  }
  if (typeof call.input.cmd === 'string') {
    return normalizeWhitespace(call.input.cmd) || 'command';
  }
  if (isRunLikeToolName(call.name)) {
    return call.name.replace(/^run\s*/i, '').trim() || 'command';
  }
  return 'command';
}

function filePreview(input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') {
    return input.file_path;
  }
  if (typeof input.path === 'string') {
    return input.path;
  }
  return 'files';
}

function compactCommandPreview(call: PairedToolCall): string {
  const command = Array.isArray(call.input.command)
    ? call.input.command.filter((part): part is string => typeof part === 'string')
    : typeof call.input.command === 'string'
      ? call.input.command
      : typeof call.input.cmd === 'string'
        ? call.input.cmd
        : commandPreview(call);
  return truncateWithEllipsis(compactCommandLabel(command), RUN_COMMAND_PREVIEW_MAX - 8);
}

function readGroupTarget(group: PairedToolCall[]): string {
  const call = group.length === 1 ? group[0] : undefined;
  const path = call ? filePreview(call.input) : 'files';
  const filename = path.split(/[/\\]/).pop();
  return path === 'files' || !filename ? 'files' : `file ${filename}`;
}

function commandGroupTarget(group: PairedToolCall[]): string {
  const call = group.length === 1 ? group[0] : undefined;
  return call ? compactCommandPreview(call) : 'commands';
}

function summaryKind(call: PairedToolCall): ToolActivityKind {
  // ACP titles can be a full command or a friendly description. Recognize
  // command payloads here without changing the expanded action's display name.
  if (
    typeof call.input.command === 'string' ||
    Array.isArray(call.input.command) ||
    typeof call.input.cmd === 'string'
  ) {
    return 'command';
  }
  return getToolActivityKind(call.name);
}

export function getToolActivityLabel(call: PairedToolCall): string {
  const kind = getToolActivityKind(call.name);
  if (kind === 'command') {
    return truncateWithEllipsis(
      `${VERBS.command[call.status]} ${commandPreview(call)}`,
      RUN_COMMAND_PREVIEW_MAX
    );
  }
  if (kind === 'edit' || kind === 'read') {
    return `${VERBS[kind][call.status]} ${filePreview(call.input)}`;
  }
  return getDisplayToolName(call.name, call.input);
}

function activityGroupLabel(kind: ToolActivityKind, group: PairedToolCall[]): string {
  const pending = group.some((call) => call.status === 'pending');
  switch (kind) {
    case 'command':
      return `${pending ? 'Running' : 'Ran'} ${commandGroupTarget(group)}`;
    case 'edit': {
      const noun =
        group.length === 1 && !isCodexFileChangeToolName(group[0]?.name ?? '') ? 'a file' : 'files';
      return `${pending ? 'Editing' : 'Edited'} ${noun}`;
    }
    case 'read':
      return `${pending ? 'Reading' : 'Read'} ${readGroupTarget(group)}`;
    case 'search':
      return pending ? 'Searching' : 'Searched';
    case 'other':
      return [
        ...new Set(
          group.map((call) => getDisplayToolName(call.name, call.input, { summary: true }))
        ),
      ].join(', ');
  }
}

export function getToolGroupLabel(calls: PairedToolCall[]): string {
  const groups = new Map<ToolActivityKind, PairedToolCall[]>();
  for (const call of calls) {
    const kind = summaryKind(call);
    const group = groups.get(kind) ?? [];
    group.push(call);
    groups.set(kind, group);
  }
  return [...groups]
    .map(([kind, group], index) => {
      const label = activityGroupLabel(kind, group);
      return index === 0 || kind === 'other'
        ? label
        : label.charAt(0).toLowerCase() + label.slice(1);
    })
    .join(', ');
}
