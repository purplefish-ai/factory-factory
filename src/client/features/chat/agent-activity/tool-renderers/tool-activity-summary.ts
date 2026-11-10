import type { PairedToolCall } from '@/lib/chat-protocol';
import { compactCommandLabel } from './compact-command-label';
import { isCodexFileChangeToolName } from './file-change-parser';
import { getMcpToolDisplay, isListFilesToolName } from './mcp-tool-display';
import {
  extractCommandPreviewFromInput,
  getDisplayToolName,
  isRunLikeToolName,
  normalizeWhitespace,
  RUN_COMMAND_PREVIEW_MAX,
  truncateWithEllipsis,
} from './tool-display-utils';
import { isWebSearchToolName } from './web-search-parser';

export type ToolActivityKind = 'command' | 'edit' | 'read' | 'search' | 'list' | 'mcp' | 'other';
const VERBS = {
  command: { pending: 'Running', error: 'Failed', success: 'Ran' },
  edit: { pending: 'Editing', error: "Couldn't edit", success: 'Edited' },
  read: { pending: 'Reading', error: "Couldn't read", success: 'Read' },
};

export function getToolActivityKind(name: string): ToolActivityKind {
  if (getMcpToolDisplay(name)) {
    return 'mcp';
  }
  if (isListFilesToolName(name)) {
    return 'list';
  }
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
  const kind = getToolActivityKind(call.name);
  if (kind === 'mcp' || kind === 'list') {
    return kind;
  }
  // ACP titles can be a full command or a friendly description. Recognize
  // command payloads here without changing the expanded action's display name.
  if (
    typeof call.input.command === 'string' ||
    Array.isArray(call.input.command) ||
    typeof call.input.cmd === 'string'
  ) {
    return 'command';
  }
  return kind;
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

function mcpGroupLabel(group: PairedToolCall[]): string {
  const services = new Map<string, number>();
  for (const call of group) {
    const service = getMcpToolDisplay(call.name)?.service ?? call.name;
    services.set(service, (services.get(service) ?? 0) + 1);
  }
  return [...services]
    .map(([service, count]) => (count > 1 ? `${service} ×${count}` : service))
    .join(', ');
}

function sentenceCaseLabel(label: string, index: number): string {
  return index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
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
    case 'list':
      return pending ? 'Listing files' : 'Listed files';
    case 'mcp':
      return mcpGroupLabel(group);
    case 'other':
      return [
        ...new Set(
          group.map((call) => getDisplayToolName(call.name, call.input, { summary: true }))
        ),
      ]
        .map(sentenceCaseLabel)
        .join(', ');
  }
}

/** Activity kinds in a collapsed group, classified the same way as its label. */
export function getToolGroupKinds(calls: PairedToolCall[]): Set<ToolActivityKind> {
  return new Set(calls.map(summaryKind));
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
      return kind === 'mcp' ? label : sentenceCaseLabel(label, index);
    })
    .join(', ');
}

/**
 * Failure suffix for an expanded group, e.g. "1 of 3 failed", so failures are
 * visible alongside its calls. Null when no call failed.
 */
export function getToolGroupFailureSummary(calls: PairedToolCall[]): string | null {
  const failed = calls.filter((call) => call.status === 'error').length;
  if (failed === 0) {
    return null;
  }
  return calls.length === 1 ? 'failed' : `${failed} of ${calls.length} failed`;
}
