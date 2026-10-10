import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeNextCadenceRunAt } from './cadence-schedule';

describe('computeNextCadenceRunAt', () => {
  // setHours/getHours (the pre-fix implementation) read the process-local
  // wall clock, so the DST regression only reproduces under a DST-observing
  // local timezone — pin one regardless of the environment's ambient TZ.
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('advances EVERY_HOUR by a real hour across a US fall-back DST transition', () => {
    // 2026-11-01 05:30 UTC = 01:30 America/New_York (EDT, UTC-4), the last
    // half hour before clocks fall back to 01:00 EST (UTC-5) at 2am local.
    const from = new Date('2026-11-01T05:30:00.000Z');
    const next = computeNextCadenceRunAt('EVERY_HOUR', from);
    expect(next.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });

  it('advances EVERY_HOUR by a real hour across a US spring-forward DST transition', () => {
    // 2026-03-08 06:30 UTC = 01:30 America/New_York (EST, UTC-5), the last
    // half hour before clocks spring forward to 03:00 EDT (UTC-4) at 2am local.
    const from = new Date('2026-03-08T06:30:00.000Z');
    const next = computeNextCadenceRunAt('EVERY_HOUR', from);
    expect(next.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });
});
