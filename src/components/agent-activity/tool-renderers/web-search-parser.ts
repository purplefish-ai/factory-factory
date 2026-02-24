import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { findTypedPayload, isObjectRecord, unwrapJsonCodeFence } from './tool-result-parse-utils';

const WEB_SEARCH_TYPE = 'websearch';
const MAX_SEARCH_DEPTH = 6;

export interface WebSearchAction {
  type: string;
  query?: string;
  queries?: string[];
}

export interface WebSearchPayload {
  type: 'webSearch';
  id?: string;
  query: string;
  action: WebSearchAction;
  rawText?: string;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeToolType(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }
  return raw.replace(/[\s_-]+/g, '').toLowerCase();
}

function normalizeToolName(name: string): string {
  return name.replace(/[\s_-]+/g, '').toLowerCase();
}

function dedupeQueries(queries: string[]): string[] {
  return Array.from(
    new Set(queries.map((query) => query.trim()).filter((query) => query.length > 0))
  );
}

function parseSearchAction(value: unknown): WebSearchAction {
  if (!isObjectRecord(value)) {
    return { type: 'other' };
  }

  const actionType = asNonEmptyString(value.type) ?? 'other';
  const query = asNonEmptyString(value.query) ?? undefined;
  const queries = Array.isArray(value.queries)
    ? dedupeQueries(value.queries.filter((entry): entry is string => typeof entry === 'string'))
    : undefined;

  return {
    type: actionType,
    ...(query ? { query } : {}),
    ...(queries && queries.length > 0 ? { queries } : {}),
  };
}

function normalizeSearchAction(action: WebSearchAction, query: string): WebSearchAction {
  if (query.length === 0) {
    return action;
  }

  const existingQueries = dedupeQueries(action.queries ?? []);
  const queries = existingQueries.length > 0 ? existingQueries : [query];
  const type = action.type.trim().toLowerCase() === 'other' ? 'search' : action.type;

  return {
    ...action,
    type,
    query,
    queries,
  };
}

function parseWebSearchPayload(value: unknown): WebSearchPayload | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (normalizeToolType(value.type) !== WEB_SEARCH_TYPE) {
    return null;
  }

  const id = asNonEmptyString(value.id) ?? undefined;
  const action = parseSearchAction(value.action);
  const queryCandidates = [asNonEmptyString(value.query), action.query, action.queries?.[0]];
  const query = queryCandidates.find((candidate) => typeof candidate === 'string') ?? '';
  const normalizedAction = normalizeSearchAction(action, query);

  return {
    type: 'webSearch',
    ...(id ? { id } : {}),
    query,
    action: normalizedAction,
  };
}

function parseWebSearchFromText(text: string): WebSearchPayload | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(unwrapJsonCodeFence(trimmed));
    const typedPayload = findTypedPayload(parsed, {
      type: WEB_SEARCH_TYPE,
      maxDepth: MAX_SEARCH_DEPTH,
    });
    if (!typedPayload) {
      return null;
    }

    const payload = parseWebSearchPayload(typedPayload);
    return payload ? { ...payload, rawText: text } : null;
  } catch {
    return null;
  }
}

export function isWebSearchToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  return normalized === WEB_SEARCH_TYPE || normalized.startsWith(`${WEB_SEARCH_TYPE}:`);
}

export function parseWebSearchToolInput(input: Record<string, unknown>): WebSearchPayload | null {
  return parseWebSearchPayload(input);
}

export function parseWebSearchToolResult(content: ToolResultContentValue): WebSearchPayload | null {
  if (typeof content === 'string') {
    return parseWebSearchFromText(content);
  }

  for (const item of content) {
    if (item.type !== 'text') {
      continue;
    }
    const payload = parseWebSearchFromText(item.text ?? '');
    if (payload) {
      return payload;
    }
  }

  return null;
}
