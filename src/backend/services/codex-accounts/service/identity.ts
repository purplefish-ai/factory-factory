import { createHash } from 'node:crypto';
export function nativeEmailFallbackKey(email: string): string {
  return `native-email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}
export function matchesNativeEmailFallback(key: string | null, email: string | null): boolean {
  if (!(key && email)) {
    return false;
  }
  const expected = nativeEmailFallbackKey(email);
  return key === expected || key.startsWith(`${expected}:imported:`);
}
