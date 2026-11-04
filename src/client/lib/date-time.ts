/** Shared local date presentation. Keep wire/storage dates in ISO format. */
type DateInput = Date | string | number | null | undefined;

export interface DateDisplayOptions {
  locale?: Intl.LocalesArgument;
  timeZone?: string;
}

interface DateTimeDisplayOptions extends DateDisplayOptions {
  /** Logs and detail tooltips include seconds; ordinary metadata uses minutes. */
  precision?: 'minute' | 'second';
}

function parseDate(value: DateInput): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The same calendar date for pickers, metadata and history, in the user's locale. */
export function formatDate(value: DateInput, options: DateDisplayOptions = {}): string {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat(options.locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: options.timeZone,
      }).format(date)
    : 'Unknown date';
}

/** Browser locale and time zone by default; explicit options make tests deterministic. */
export function formatDateTime(value: DateInput, options: DateTimeDisplayOptions = {}): string {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat(options.locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(options.precision === 'second' ? { second: '2-digit' } : {}),
        timeZone: options.timeZone,
      }).format(date)
    : 'Unknown date';
}

/** Valid machine-readable time, including milliseconds; invalid dates omit the attribute. */
export function toDateTimeIso(value: DateInput): string | undefined {
  return parseDate(value)?.toISOString();
}
