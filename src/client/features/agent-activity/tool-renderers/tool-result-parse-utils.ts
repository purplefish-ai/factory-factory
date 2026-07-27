export function unwrapJsonCodeFence(raw: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  return match?.[1] ?? raw;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Depth-limited recursive search for an object payload with a matching `type`.
 */
export function findTypedPayload(
  value: unknown,
  params: { type: string; maxDepth: number; depth?: number }
): Record<string, unknown> | null {
  const depth = params.depth ?? 0;
  if (depth > params.maxDepth) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findTypedPayload(item, {
        type: params.type,
        maxDepth: params.maxDepth,
        depth: depth + 1,
      });
      if (match) {
        return match;
      }
    }
    return null;
  }

  if (!isObjectRecord(value)) {
    return null;
  }

  const typeValue = value.type;
  if (typeof typeValue === 'string' && typeValue.toLowerCase() === params.type.toLowerCase()) {
    return value;
  }

  for (const nested of Object.values(value)) {
    const match = findTypedPayload(nested, {
      type: params.type,
      maxDepth: params.maxDepth,
      depth: depth + 1,
    });
    if (match) {
      return match;
    }
  }

  return null;
}
