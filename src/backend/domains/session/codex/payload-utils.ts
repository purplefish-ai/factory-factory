export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}
