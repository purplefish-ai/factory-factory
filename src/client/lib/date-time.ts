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

type DatePrecision = 'date' | 'minute' | 'second';
const MAX_FORMATTERS = 16;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cache configurations rather than dates; explicit locale/time-zone variants stay bounded. */
function getFormatter(options: DateDisplayOptions, precision: DatePrecision): Intl.DateTimeFormat {
  const locale = options.locale;
  const localeStrings =
    locale === undefined ? [] : Array.isArray(locale) ? locale.map(String) : [String(locale)];
  const key = JSON.stringify({
    locales: Intl.getCanonicalLocales(localeStrings),
    timeZone: options.timeZone,
    precision,
  });
  const cached = formatters.get(key);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(precision !== 'date' ? ({ hour: 'numeric', minute: '2-digit' } as const) : {}),
    ...(precision === 'second' ? ({ second: '2-digit' } as const) : {}),
    timeZone: options.timeZone,
  });
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) {
      formatters.delete(oldest);
    }
  }
  formatters.set(key, formatter);
  return formatter;
}

/** The same calendar date for pickers, metadata and history, in the user's locale. */
export function formatDate(value: DateInput, options: DateDisplayOptions = {}): string {
  const date = parseDate(value);
  return date ? getFormatter(options, 'date').format(date) : 'Unknown date';
}

/** Browser locale and time zone by default; explicit options make tests deterministic. */
export function formatDateTime(value: DateInput, options: DateTimeDisplayOptions = {}): string {
  const date = parseDate(value);
  return date ? getFormatter(options, options.precision ?? 'minute').format(date) : 'Unknown date';
}

/** Valid machine-readable time, including milliseconds; invalid dates omit the attribute. */
export function toDateTimeIso(value: DateInput): string | undefined {
  return parseDate(value)?.toISOString();
}
