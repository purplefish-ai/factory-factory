/**
 * Vocabulary for the upgrade seed: rows are plain data, written the way the
 * last release's application wrote them (Prisma stores DateTime as ISO text
 * with a `+00:00` offset and JSON as text), so reading them back exercises the
 * same code paths a real user database does.
 */
export type SeedValue =
  | string
  | number
  | boolean
  | null
  | SeedValue[]
  | { [key: string]: SeedValue };
export type SeedRow = Record<string, SeedValue>;
/** Table name to rows; tables are inserted in key order, so parents come first. */
export type SeedTables = Record<string, SeedRow[]>;

const SEED_EPOCH_MS = Date.UTC(2026, 10, 20, 10, 0, 0);

/** A DateTime column value, `minutes` after the seed epoch, as Prisma writes it. */
export function stamp(minutes: number): string {
  return new Date(SEED_EPOCH_MS + minutes * 60_000).toISOString().replace('Z', '+00:00');
}

/** A timestamp inside a JSON document (`z.iso.datetime()` accepts only the `Z` form). */
export function iso(minutes: number): string {
  return new Date(SEED_EPOCH_MS + minutes * 60_000).toISOString();
}

/**
 * Minutes from the seed epoch to about the year 2096. Every expiry and deadline in
 * the seed sits here, so the check does not start failing when a real date passes.
 */
export const FAR_FUTURE = 60 * 24 * 365 * 70;

/** A pid no operating system hands out, so no seeded row can ever name a live process. */
export const UNUSED_PID = 2_000_000_000;

export const PROJECT_GITHUB = 'seed-project-github';
export const PROJECT_LINEAR = 'seed-project-linear';
export const SEED_REPO_ROOT = '/tmp/ff-upgrade-seed';
