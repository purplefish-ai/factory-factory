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
  per list query. `reconcileWorkspaceCommandCache` re-reads the file and repairs
  drift before a script starts or stops instead.
- The runtime group is persisted even though a restart invalidates the process
  it describes, because `pid` is the only handle on an orphaned run script:
  `verifyRunning` probes it with `process.kill(pid, 0)`. Startup clears only
  `STARTING` and `STOPPING`.
- Registering an initialized worktree writes the worktree columns and the
  commands in one transaction, as the single statement before the split did.

## Consequences

- A list read never touches the filesystem; a stale command cache is corrected
  at the point of use.
- A run script that survives a crash can still be found and stopped.
- `postRunCommand` was never part of the export format; the backup column test
  lists it as a known gap, and the cache refills from the file.
