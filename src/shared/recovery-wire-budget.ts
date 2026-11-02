import superjson from 'superjson';

// Independent of the archive decoded-byte caps: JSON escaping and all other
// relational data also consume this logical package budget.
export const MAX_RECOVERY_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_RECOVERY_HTTP_BODY_BYTES = 65 * 1024 * 1024;

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Recovery package must be JSON serializable.');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

/** Mirrors the mutation httpBatchLink + SuperJSON single-input HTTP envelope. */
export function assertRecoveryWireBudget(value: unknown): void {
  if (jsonBytes(value) > MAX_RECOVERY_PACKAGE_BYTES) {
    throw new RangeError('Recovery package exceeds the 64 MiB serialized JSON limit.');
  }
  if (jsonBytes({ 0: superjson.serialize(value) }) > MAX_RECOVERY_HTTP_BODY_BYTES) {
    throw new RangeError('Recovery request exceeds the 65 MiB HTTP body limit.');
  }
}
