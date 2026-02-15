import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';

const MAX_PLAN_SEARCH_DEPTH = 6;
const PLAN_TYPE = 'plan';

function unwrapJsonCodeFence(raw: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  return match?.[1] ?? raw;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findPlanPayload(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > MAX_PLAN_SEARCH_DEPTH) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const plan = findPlanPayload(item, depth + 1);
      if (plan) {
        return plan;
      }
    }
    return null;
  }

  if (!isObjectRecord(value)) {
    return null;
  }

  const typeValue = value.type;
  if (typeof typeValue === 'string' && typeValue.toLowerCase() === PLAN_TYPE) {
    return value;
  }

  for (const nested of Object.values(value)) {
    const plan = findPlanPayload(nested, depth + 1);
    if (plan) {
      return plan;
    }
  }

  return null;
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

  const planPayload = findPlanPayload(parsed, 0);
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
