# Reopen workspaces after PR completion

**Goal:** Accepted human follow-ups make completed PRs historical for workspace
completion. Active turns use Working; idle follow-ups use Waiting. Subsequent
PRs can complete the workspace again. Keep all PR history and monitoring.

**Architecture:** Persist a completion dismissal on each terminal association.
Only explicit human input admission dismisses existing terminal PRs, before
dispatch. Shared aggregation excludes dismissed terminal PRs from completion,
but retains counts and all display identities. Nonterminal observations reset
the dismissal. Backups preserve it and older payloads default to false.

**Tech stack:** TypeScript, Prisma/SQLite, Vitest.

- [x] Add failing aggregation and human-admission regression tests.
- [x] Add the Prisma field, additive migration, serialization and backup
      support.
- [x] Implement dismissal through the workspace capsule and an injected
      orchestration callback at human queue admission; publish the updated
      collection immediately. Keep rejected and background messages excluded.
- [x] Verify persistence, repeated polling, new PR completion, reopening,
      multiple PRs, and admission ordering with focused tests.
- [x] Update workspace state documentation and run repository verification.

Review focus: old payload compatibility; history remains attached; background
delivery never calls human admission; every terminal sibling is dismissed;
future terminal transitions can still complete work. An observation timestamp
guard prevents delayed admission writes from dismissing later observed merges.

Implementation review added dispatch and steering holds during admission, a
stable first terminal observation time, and recovery after publication failure.

Verification: repository checks, Prisma generation/ownership checks, typecheck,
and 1,504 integration tests passed. The full application run passed 14,264 tests
and found three canonical backup fixture mismatches; adding the new PR fields to
those fixtures made all 287 affected schema and admission tests pass.
