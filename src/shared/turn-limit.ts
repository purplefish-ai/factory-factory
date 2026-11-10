import { z } from 'zod';

/** Whole minutes, capped at one week to stay within Node's timer range. */
export const turnLimitMinutesSchema = z.number().int().min(1).max(10_080).nullable();

export function turnLimitMs(minutes: number | null | undefined): number | undefined {
  return minutes == null ? undefined : minutes * 60_000;
}

export function turnLimitMessage(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  const duration = minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return `Turn stopped: reached the ${duration} limit.`;
}
