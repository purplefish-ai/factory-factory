# Backups use private SQLite transactions

Originally decided on 2026-11-02 in #2840 (export) and #2841 (import).

## Context

Backup export and import used the application's shared database connection. An
export read its tables one by one, so a concurrent change (for example to Codex
accounts) could produce a backup with old session bindings and a new account
inventory. An import's transaction on the shared connection could absorb an
ordinary application write accepted during the import and roll it back with the
import.

## Decision

Both directions open a private SQLite connection on the source connection's
actual main database file; a missing or in-memory database fails closed.

- Export reads relational data and account metadata in one physically readonly
  transaction, so ordinary WAL writers keep committing while it reads a
  consistent snapshot.
- Import writes every owner through one tuned writer transaction, so a failed
  import rolls back only its own rows.
- Both have a 120-second transaction budget and a 5-second busy wait. SQLite
  still allows one writer at a time: an import's contention or expiry returns a
  CONFLICT asking the operator to retry the whole import, while an export's
  failure keeps its original error. No statement or row retries automatically.

## Consequences

- A backup is internally consistent, and the export connection cannot modify the
  database.
- Application writes made during an import survive its rollback.
- A busy database can fail an import that a retry later completes.
- A disconnect failure after commit is reported as a cleanup error, never as a
  retry instruction.
