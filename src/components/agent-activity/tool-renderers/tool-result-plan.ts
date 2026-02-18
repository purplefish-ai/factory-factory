import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { findTypedPayload, unwrapJsonCodeFence } from './tool-result-parse-utils';

const MAX_PLAN_SEARCH_DEPTH = 6;
const PLAN_TYPE = 'plan';

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
