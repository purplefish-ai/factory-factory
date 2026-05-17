const MAX_ERROR_MESSAGE_LENGTH = 4000;

function truncate(value: string): string {
  if (value.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readErrorCode(value: Record<string, unknown>): string | number | null {
  return typeof value.code === 'number' || typeof value.code === 'string' ? value.code : null;
}

function readErrorReason(value: Record<string, unknown>): string | null {
  return readString(value.reason) ?? (isRecord(value.data) ? readString(value.data.reason) : null);
}

function summarizeErrorObject(error: Record<string, unknown>): string {
  const message = readString(error.message);
  const reason = readErrorReason(error);
  const code = readErrorCode(error);

  const parts: string[] = [];
  if (code !== null) {
    parts.push(`code ${code}`);
  }
  if (message) {
    parts.push(message);
  }
  if (reason && reason !== message) {
    parts.push(reason);
  }

  if (parts.length > 0) {
    return truncate(parts.join(': '));
  }

  const keys = Object.keys(error).slice(0, 5);
  return keys.length > 0 ? `Object(${keys.join(', ')})` : '[object Object]';
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return truncate(error.message);
  }
  if (isRecord(error)) {
    return summarizeErrorObject(error);
  }
  return truncate(String(error));
}
