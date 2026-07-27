import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { findTypedPayload, isObjectRecord, unwrapJsonCodeFence } from './tool-result-parse-utils';

const FILE_CHANGE_TYPE = 'filechange';
const MAX_SEARCH_DEPTH = 6;

export type CodexFileChangeKind = 'create' | 'update' | 'delete' | 'move' | 'unknown';

export interface CodexFileChangeEntry {
  path: string;
  kind: CodexFileChangeKind;
  diff?: string;
  movePath?: string | null;
}

export interface CodexFileChangePayload {
  id?: string;
  status?: string;
  changes: CodexFileChangeEntry[];
  rawText?: string;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeToolName(name: string): string {
  return name.replace(/[\s_-]+/g, '').toLowerCase();
}

function parseKind(kindValue: unknown, movePath: string | null): CodexFileChangeKind {
  const rawKind =
    typeof kindValue === 'string'
      ? kindValue
      : isObjectRecord(kindValue)
        ? (asNonEmptyString(kindValue.type) ?? '')
        : '';

  switch (rawKind.toLowerCase()) {
    case 'create':
    case 'add':
    case 'added':
      return 'create';
    case 'update':
    case 'edit':
    case 'modified':
      return movePath ? 'move' : 'update';
    case 'delete':
    case 'remove':
    case 'deleted':
      return 'delete';
    case 'move':
    case 'rename':
      return 'move';
    default:
      return movePath ? 'move' : 'unknown';
  }
}

function parseFileChangeEntry(value: unknown): CodexFileChangeEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const path = asNonEmptyString(value.path);
  if (!path) {
    return null;
  }

  const kindValue = value.kind;
  const movePath =
    (isObjectRecord(kindValue) ? asNonEmptyString(kindValue.move_path) : null) ??
    asNonEmptyString(value.move_path) ??
    asNonEmptyString(value.movePath);

  const diff = asNonEmptyString(value.diff);

  return {
    path,
    kind: parseKind(kindValue, movePath),
    ...(diff ? { diff } : {}),
    ...(movePath ? { movePath } : {}),
  };
}

function isCodexFileChangeEntry(value: CodexFileChangeEntry | null): value is CodexFileChangeEntry {
  return value !== null;
}

function parseFileChangePayload(value: unknown): CodexFileChangePayload | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const type = asNonEmptyString(value.type)?.toLowerCase();
  if (type !== FILE_CHANGE_TYPE) {
    return null;
  }

  const changes = value.changes;
  const parsedChanges = Array.isArray(changes)
    ? changes.map(parseFileChangeEntry).filter(isCodexFileChangeEntry)
    : [];
  const id = asNonEmptyString(value.id) ?? undefined;
  const status = asNonEmptyString(value.status) ?? undefined;

  return {
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
    changes: parsedChanges,
  };
}

function parseFileChangeFromText(text: string): CodexFileChangePayload | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(unwrapJsonCodeFence(trimmed));
    const typedPayload = findTypedPayload(parsed, {
      type: FILE_CHANGE_TYPE,
      maxDepth: MAX_SEARCH_DEPTH,
    });
    if (!typedPayload) {
      return null;
    }

    const payload = parseFileChangePayload(typedPayload);
    return payload ? { ...payload, rawText: text } : null;
  } catch {
    return null;
  }
}

export function isCodexFileChangeToolName(name: string): boolean {
  return /^filechanges?$/.test(normalizeToolName(name));
}

export function parseCodexFileChangeToolInput(
  input: Record<string, unknown>
): CodexFileChangePayload | null {
  return parseFileChangePayload(input);
}

export function parseCodexFileChangeToolResult(
  content: ToolResultContentValue
): CodexFileChangePayload | null {
  if (typeof content === 'string') {
    return parseFileChangeFromText(content);
  }

  for (const item of content) {
    if (item.type !== 'text') {
      continue;
    }
    const payload = parseFileChangeFromText(item.text ?? '');
    if (payload) {
      return payload;
    }
  }

  return null;
}

export function serializeUnknownPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
