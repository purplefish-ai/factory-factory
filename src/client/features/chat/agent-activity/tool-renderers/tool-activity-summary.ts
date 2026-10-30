import type { PairedToolCall } from '@/lib/chat-protocol';
import { isCodexFileChangeToolName } from './file-change-parser';
import {
  extractCommandPreviewFromInput,
  getDisplayToolName,
  isRunLikeToolName,
  normalizeWhitespace,
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

export function getToolActivityLabel(call: PairedToolCall): string {
  const kind = getToolActivityKind(call.name);
  if (kind === 'command') {
    return `${VERBS.command[call.status]} ${commandPreview(call)}`;
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
      return pending ? 'Running commands' : 'Ran commands';
    case 'edit': {
      const noun =
        group.length === 1 && !isCodexFileChangeToolName(group[0]?.name ?? '') ? 'a file' : 'files';
      return `${pending ? 'Editing' : 'Edited'} ${noun}`;
    }
    case 'read':
      return pending ? 'Reading files' : 'Read files';
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
    const kind = getToolActivityKind(call.name);
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
