import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { findTypedPayload, isObjectRecord, unwrapJsonCodeFence } from './tool-result-parse-utils';

const MAX_PLAN_SEARCH_DEPTH = 6;
const PLAN_TYPE = 'plan';
const PLAN_TEXT_KEYS = ['plan', 'markdown', 'text', 'content'] as const;

function hasPlanTextContent(value: unknown, depth = 0): boolean {
  if (depth > MAX_PLAN_SEARCH_DEPTH) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasPlanTextContent(item, depth + 1));
  }

  if (!isObjectRecord(value)) {
    return false;
  }

  return PLAN_TEXT_KEYS.some((key) => key in value && hasPlanTextContent(value[key], depth + 1));
}

function extractPlanResultFromRawText(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const json = unwrapJsonCodeFence(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const planPayload = findTypedPayload(parsed, {
    type: PLAN_TYPE,
    maxDepth: MAX_PLAN_SEARCH_DEPTH,
  });
  if (!planPayload) {
    return null;
  }

  if (!hasPlanTextContent(planPayload)) {
    return null;
  }

  return extractPlanText(planPayload);
}

export interface ExtractedPlanToolResult {
  planText: string;
  rawText: string;
}

/**
 * Detect Codex plan tool-result payloads and extract markdown text for UI rendering.
 */
export function extractPlanToolResult(
  content: ToolResultContentValue
): ExtractedPlanToolResult | null {
  if (typeof content === 'string') {
    const planText = extractPlanResultFromRawText(content);
    return planText ? { planText, rawText: content } : null;
  }

  for (const item of content) {
    if (item.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }
    const planText = extractPlanResultFromRawText(item.text);
    if (planText) {
      return { planText, rawText: item.text };
    }
  }

  return null;
}
