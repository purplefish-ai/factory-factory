import { UnknownAppliedMigrationsError, type UnknownMigrationPolicy } from '@/backend/migrate';

/** Set to `1` to start an `ff` command on a database with migrations this build does not ship. */
export const ALLOW_UNKNOWN_MIGRATIONS_ENV = 'FF_ALLOW_UNKNOWN_MIGRATIONS';

/**
 * Development worktrees on different branches can share one database, so
 * `ff serve --dev` only warns. Everything else refuses unless explicitly overridden.
 */
export function resolveUnknownMigrationPolicy(options: {
  dev?: boolean;
  env: Record<string, string | undefined>;
}): UnknownMigrationPolicy {
  return options.dev || options.env[ALLOW_UNKNOWN_MIGRATIONS_ENV] === '1' ? 'warn' : 'refuse';
}

/** Startup failure text for a migration error, with recovery advice for a downgrade. */
export function describeMigrationFailure(error: unknown): string {
  if (error instanceof UnknownAppliedMigrationsError) {
    return (
      `${error.message}\n` +
      '  If these migrations came from a development branch that shares this database, ' +
      `use \`ff serve --dev\` or set ${ALLOW_UNKNOWN_MIGRATIONS_ENV}=1 to start anyway.`
    );
  }
  return `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
}
