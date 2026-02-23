import type { ToolCallUpdate } from '@agentclientprotocol/sdk';

const COMMAND_EXECUTION_SESSION_HANDOFF_LINE_PATTERN =
  /^process running with session id(?:\s*[:#-]?\s*[a-z0-9_-]+)?\.?$/i;

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toTurnItemKey(turnId: string, itemId: string): string {
  return `${turnId}:${itemId}`;
}

function extractToolCallIdFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return asString(value.callId) ?? asString(value.call_id) ?? null;
}

export function resolveToolCallId(params: { itemId: string; source?: unknown }): string {
  return extractToolCallIdFromUnknown(params.source) ?? params.itemId;
}

export function isCommandExecutionSessionHandoffOutput(output: string): boolean {
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0 || /[\r\n]/.test(trimmedOutput)) {
    return false;
  }
  return COMMAND_EXECUTION_SESSION_HANDOFF_LINE_PATTERN.test(trimmedOutput);
}

export function toToolStatus(status: unknown): ToolCallUpdate['status'] | undefined {
  if (status === 'inProgress') {
    return 'in_progress';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed' || status === 'declined') {
    return 'failed';
  }
  return undefined;
}

export function dedupeLocations(
  locations: Array<{ path: string; line?: number | null }>
): Array<{ path: string; line?: number | null }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; line?: number | null }> = [];
  for (const location of locations) {
    const key = `${location.path}:${location.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(location);
  }
  return result;
}
