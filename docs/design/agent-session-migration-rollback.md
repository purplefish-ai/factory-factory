# AgentSession Migration Rollback Notes

This document covers rollback handling for migration `20260212163000_agent_session_provider_cutover`.

## Preconditions

- Take a full DB backup before deploy.
- Ensure maintenance mode blocks chat/session writes during migration.
- Confirm all RUNNING sessions are drained/stopped before migration starts.

## Failure Handling

- The migration is transactional in the app migration runner.
- If any migration step fails, the migration transaction is rolled back and `ClaudeSession` remains intact.
- Do not continue startup on a partially failed migration run.

## Rollback Procedure

1. Stop the new app build.
2. Restore the DB from the pre-migration backup.
3. Revert to the previous app build.
4. Start services and verify:
   - legacy session endpoints can list and load sessions,
   - ratchet has no active stuck fixer pointers,
   - no orphaned session processes are running.

## Post-Restore Validation

- `ClaudeSession` table exists and row count matches pre-deploy backup.
- `_prisma_migrations` does not contain a successful entry for `20260212163000_agent_session_provider_cutover`.
- UI workspace/session load works on at least one previously active workspace.

## Retry Guidance

Before retrying migration:

- Re-run preflight checks (provider prerequisites, DB health, disk space).
- Address root cause from migration logs.
- Re-take a fresh backup.
