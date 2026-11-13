# PR polling reads whether an observation exists, not the observation

Originally decided on 2026-11-09 in #3134.

## Context

Each `WorkspacePR` row stores its complete normalized observation as JSON, and
polled reads (the watcher's monitoring list and the scheduler's stale-PR read)
ran every few minutes for every workspace. The terminal-polling policy needs to
know only whether an observation is stored, yet the reads moved every blob
through Prisma and JSON parsing.

## Decision

`shouldPollPR` reads only the presence of an observation. Polled reads omit the
observation column and, in the same read transaction, ask SQLite which PRs have
none (SQL NULL or JSON null). That query reads the type and length from the
record header (`typeof`, `octet_length`) and compares a value with `'null'` only
when it is four bytes long, so SQLite does not read a stored observation's
overflow pages either.

## Consequences

- Terminal PRs still match the scheduler's SQL filter and are dropped in
  application code, because the policy compares each PR's observation epoch with
  its workspace's monitoring epoch, which a Prisma filter cannot express.
- A new polled read that needs observation contents must say so explicitly and
  is a cost to measure, not a default.
