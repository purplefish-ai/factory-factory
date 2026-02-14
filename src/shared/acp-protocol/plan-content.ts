const MAX_EXTRACTION_DEPTH = 8;

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? value;
}

function isLikelyMarkdown(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith('#') ||
    trimmed.includes('\n#') ||
    trimmed.includes('\n##') ||
    trimmed.includes('\n- ') ||
    trimmed.includes('\n1. ')
  );
}

function chooseBestCandidate(candidates: string[]): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const markdown = candidates
    .filter((candidate) => isLikelyMarkdown(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (markdown) {
    return markdown;
  }

  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

function collectCandidates(values: unknown[], depth: number): string[] {
  return values
    .map((value) => extractFromUnknown(value, depth + 1))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function extractFromString(value: string, depth: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const unwrapped = stripCodeFence(trimmed);
  if (unwrapped !== trimmed) {
    const fromFence = extractFromUnknown(unwrapped, depth + 1);
    if (fromFence) {
      return fromFence;
    }
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return extractFromUnknown(parsed, depth + 1);
    } catch {
      return value;
    }
  }

  return value;
}

function extractFromArray(value: unknown[], depth: number): string | null {
  const candidates = collectCandidates(value, depth);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.join('\n\n');
}

function extractPreferredField(record: Record<string, unknown>, depth: number): string | null {
  const preferredKeys = ['plan', 'markdown', 'text', 'content', 'value', 'message'] as const;
  for (const key of preferredKeys) {
    if (!(key in record)) {
      continue;
    }
    const extracted = extractFromUnknown(record[key], depth + 1);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function extractTextTypedObject(record: Record<string, unknown>): string | null {
  const type = Reflect.get(record, 'type');
  if (type !== 'text' && type !== 'markdown') {
    return null;
  }

  const text = Reflect.get(record, 'text');
  if (typeof text === 'string' && text.trim().length > 0) {
    return text;
  }

  return null;
}

function extractFromObject(value: Record<string, unknown>, depth: number): string | null {
  const preferred = extractPreferredField(value, depth);
  if (preferred) {
    return preferred;
  }

  const typedText = extractTextTypedObject(value);
  if (typedText) {
    return typedText;
  }

  const candidates = collectCandidates(Object.values(value), depth);
  return chooseBestCandidate(candidates);
}

function extractFromUnknown(value: unknown, depth: number): string | null {
  if (depth > MAX_EXTRACTION_DEPTH) {
    return null;
  }

  if (typeof value === 'string') {
    return extractFromString(value, depth);
  }

  if (Array.isArray(value)) {
    return extractFromArray(value, depth);
  }

  if (typeof value === 'object' && value !== null) {
    return extractFromObject(value as Record<string, unknown>, depth);
  }

  return null;
}

/**
 * Extract markdown/text plan content from ACP ExitPlanMode payloads.
 * Returns null when no textual plan can be found.
 */
export function extractPlanText(value: unknown): string | null {
  return extractFromUnknown(value, 0);
}
