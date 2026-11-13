# The run-script row caches config and persists runtime

Originally decided on 2026-07-26 in #2031.

## Context

`WorkspaceRunScript` holds two kinds of column: the three commands (`command`,
`postRunCommand`, `cleanupCommand`), which come from the worktree's
`factory-factory.json`, and the four runtime columns (`pid`, `port`,
`startedAt`, `status`), which describe a live process. Other derived workspace
state, such as the Kanban column and `RatchetState`, is computed on read instead
of stored.

## Decision

- The two groups share one row because they share one writer.
- The commands stay a cache rather than being derived on read. Their source of
  truth is a file, so deriving them would cost a filesystem call per workspace
  per list query. Before a script starts or stops,
  `reconcileWorkspaceCommandCache` re-reads the file and runs its commands,
  bypassing a stale cache without writing it; the cache itself is rewritten when
  the configuration is saved or refreshed through
  `run-script-config-persistence.service.ts`.
- The runtime group is persisted even though a restart invalidates the process
  it describes, because `pid` is the only handle on an orphaned run script:
  `verifyRunning` probes it with `process.kill(pid, 0)`. Startup clears only
  `STARTING` and `STOPPING`.
- Registering an initialized worktree writes the worktree columns and the
  commands in one transaction, as the single statement before the split did.

## Consequences

- A list read never touches the filesystem. A stale command cache is bypassed at
  the point of use, but list reads and exports show it until a save or refresh
  rewrites it.
- A run script that survives a crash can still be found and stopped.
- `postRunCommand` was never part of the export format; the backup column test
  lists it as a known gap; starting the script reads it from the file, and a
  save or refresh of the configuration refills the cache.
