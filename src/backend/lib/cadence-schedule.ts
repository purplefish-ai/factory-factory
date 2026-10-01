import type { PeriodicTaskCadence } from '@/shared/core';

/**
 * Pure cadence math shared by Periodic Tasks and the workspace wake schedule:
 * given a cadence and an optional time-of-day/timezone/day-of-month, compute
 * the next run timestamp. No Prisma or other I/O dependency, so both
 * capsules' accessors can import it without crossing capsule boundaries.
 */

const LONG_CADENCES = new Set<PeriodicTaskCadence>(['DAILY', 'WEEKLY', 'MONTHLY']);
const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 12 * 60;

type TimeZoneDateParts = { year: number; month: number; day: number };
type TimeZoneDateTimeParts = TimeZoneDateParts & { hour: number; minute: number };
type ScheduledTimeParts = { hours: number; minutes: number };

function getTimeZoneDateParts(date: Date, timezone: string): TimeZoneDateParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function getTimeZoneDateTimeParts(
  date: Date,
  formatter: Intl.DateTimeFormat
): TimeZoneDateTimeParts {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function parseScheduledTime(scheduledTime: string): ScheduledTimeParts {
  const parts = scheduledTime.split(':').map(Number);
  return {
    hours: parts[0] ?? 0,
    minutes: parts[1] ?? 0,
  };
}

function getTimeZoneTimeParts(date: Date, timezone: string): ScheduledTimeParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return {
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Convert an intended local datetime in the user's timezone to UTC.
 * Uses the Intl API — no extra deps.
 */
function dateFromTimeZoneDateTime(
  dateParts: TimeZoneDateParts,
  timeParts: ScheduledTimeParts,
  timezone: string
): Date {
  const utcProbeMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hours,
    timeParts.minutes,
    0
  );
  const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  for (
    let offsetMinutes = MIN_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes <= MAX_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes += 1
  ) {
    const candidate = new Date(utcProbeMs + offsetMinutes * 60_000);
    const candidateParts = getTimeZoneDateTimeParts(candidate, dateTimeFormatter);

    if (
      candidateParts.year === dateParts.year &&
      candidateParts.month === dateParts.month &&
      candidateParts.day === dateParts.day &&
      candidateParts.hour === timeParts.hours &&
      candidateParts.minute === timeParts.minutes
    ) {
      return candidate;
    }
  }

  // The requested local wall-clock time can be nonexistent on spring-forward
  // transition days. Run at the first valid later local time on that date.
  for (
    let offsetMinutes = MIN_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes <= MAX_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes += 1
  ) {
    const candidate = new Date(utcProbeMs + offsetMinutes * 60_000);
    const candidateParts = getTimeZoneDateTimeParts(candidate, dateTimeFormatter);
    const candidateClockMinutes = candidateParts.hour * 60 + candidateParts.minute;

    if (
      candidateParts.year === dateParts.year &&
      candidateParts.month === dateParts.month &&
      candidateParts.day === dateParts.day &&
      candidateClockMinutes > timeParts.hours * 60 + timeParts.minutes
    ) {
      return candidate;
    }
  }

  return new Date(utcProbeMs);
}

function computeNextMonthlyRunAtInTimeZone(
  from: Date,
  scheduledTime: string | null | undefined,
  timezone: string,
  scheduledDayOfMonth: number | null | undefined
): Date {
  const fromParts = getTimeZoneDateParts(from, timezone);
  const targetYear = fromParts.month === 12 ? fromParts.year + 1 : fromParts.year;
  const targetMonth = fromParts.month === 12 ? 1 : fromParts.month + 1;
  const targetDay = Math.min(
    scheduledDayOfMonth ?? fromParts.day,
    daysInMonth(targetYear, targetMonth)
  );
  const target = dateFromTimeZoneDateTime(
    { year: targetYear, month: targetMonth, day: targetDay },
    scheduledTime ? parseScheduledTime(scheduledTime) : getTimeZoneTimeParts(from, timezone),
    timezone
  );

  if (!scheduledTime) {
    target.setUTCSeconds(from.getUTCSeconds(), from.getUTCMilliseconds());
  }

  return target;
}

/**
 * When a task has a scheduledTime + timezone, snap the computed next date to
 * that clock time in the user's timezone.
 */
function applyScheduledTime(date: Date, scheduledTime: string, timezone: string): Date {
  return dateFromTimeZoneDateTime(
    getTimeZoneDateParts(date, timezone),
    parseScheduledTime(scheduledTime),
    timezone
  );
}

export function getDayOfMonth(date: Date, timezone?: string | null): number {
  if (!timezone) {
    return date.getDate();
  }

  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
  }).format(date);

  return Number(day);
}

export function computeNextCadenceRunAt(
  cadence: PeriodicTaskCadence,
  from: Date = new Date(),
  scheduledTime?: string | null,
  timezone?: string | null,
  scheduledDayOfMonth?: number | null
): Date {
  const next = new Date(from);
  switch (cadence) {
    case 'EVERY_MINUTE':
      next.setMinutes(next.getMinutes() + 1);
      break;
    case 'EVERY_FIVE_MINUTES':
      next.setMinutes(next.getMinutes() + 5);
      break;
    case 'EVERY_HOUR':
      // Fixed millisecond advance, not setHours: setHours moves the
      // process-local wall clock, which skips or repeats an hour across a
      // DST transition instead of advancing by a real hour.
      next.setTime(next.getTime() + 60 * 60 * 1000);
      break;
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'MONTHLY': {
      if (timezone) {
        return computeNextMonthlyRunAtInTimeZone(
          from,
          scheduledTime,
          timezone,
          scheduledDayOfMonth
        );
      }

      const targetMonth = next.getMonth() + 1;
      next.setDate(1); // Avoid overflow when advancing month
      next.setMonth(targetMonth);
      const targetDay = scheduledDayOfMonth ?? getDayOfMonth(from, timezone);
      const lastDay = daysInMonth(next.getFullYear(), next.getMonth() + 1);
      next.setDate(Math.min(targetDay, lastDay));
      break;
    }
  }

  if (scheduledTime && timezone && LONG_CADENCES.has(cadence)) {
    return applyScheduledTime(next, scheduledTime, timezone);
  }

  return next;
}
