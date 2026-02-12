export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function parseThreadId(value: unknown): string | null {
  const record = asRecord(value);
  if (typeof record.threadId === 'string') {
    return record.threadId;
  }
  const thread = asRecord(record.thread);
  if (typeof thread.id === 'string') {
    return thread.id;
  }
  return null;
}

export function parseTurnId(value: unknown): string | null {
  const record = asRecord(value);
  if (typeof record.turnId === 'string') {
    return record.turnId;
  }
  const turn = asRecord(record.turn);
  if (typeof turn.id === 'string') {
    return turn.id;
  }
  return null;
}
