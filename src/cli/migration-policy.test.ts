import { describe, expect, it } from 'vitest';
import { UnknownAppliedMigrationsError } from '@/backend/migrate';
import { describeMigrationFailure, resolveUnknownMigrationPolicy } from './migration-policy';

describe('resolveUnknownMigrationPolicy', () => {
  it('refuses unknown migrations by default', () => {
    expect(resolveUnknownMigrationPolicy({ env: {} })).toBe('refuse');
    expect(resolveUnknownMigrationPolicy({ dev: false, env: {} })).toBe('refuse');
  });

  it('only warns in development mode, where worktrees share a database', () => {
    expect(resolveUnknownMigrationPolicy({ dev: true, env: {} })).toBe('warn');
  });

  it('honors the explicit override only when set to 1', () => {
    expect(resolveUnknownMigrationPolicy({ env: { FF_ALLOW_UNKNOWN_MIGRATIONS: '1' } })).toBe(
      'warn'
    );
    expect(resolveUnknownMigrationPolicy({ env: { FF_ALLOW_UNKNOWN_MIGRATIONS: 'true' } })).toBe(
      'refuse'
    );
  });
});

describe('describeMigrationFailure', () => {
  it('explains a downgrade and how to proceed', () => {
    const text = describeMigrationFailure(
      new UnknownAppliedMigrationsError('/data/data.db', ['20990101000000_future'])
    );

    expect(text).toContain('20990101000000_future');
    expect(text).toContain('Upgrade Factory Factory');
    expect(text).toContain('ff serve --dev');
    expect(text).toContain('FF_ALLOW_UNKNOWN_MIGRATIONS=1');
    expect(text).not.toMatch(/^Migration failed/);
  });

  it('labels other errors as migration failures', () => {
    expect(describeMigrationFailure(new Error('near "TABL": syntax error'))).toBe(
      'Migration failed: near "TABL": syntax error'
    );
  });
});
