# Main-session PR events implementation record

The approved replacement delivers CI, review, conflict and terminal PR events
into the bound ordinary conversation through its existing queue. Busy sessions
receive events on their next turn. No Ratchet fixer session is created.

Implementation: `37e0eafbec716665afb129fdb5f83b480197afe7`.

## Final review

One fresh reviewer inspected the complete implementation against the approved
[plan](2026-10-08-main-session-pr-events.md) and
[design](../specs/2026-10-08-main-session-pr-events-design.md). The reviewer
found no critical or minor findings and declined no judgments. Five important
findings were accepted and corrected in one fix pass:

| Finding                                                   | Correction and regression evidence                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exhausted delivery cannot retry after explicit resume     | Renew attempts atomically with the binding revision, preserving frozen identity and text. SQLite regression failed at attempts 3, then passed with attempts 0 and next claim 1.                                                       |
| Closed recipient prevents receipt recovery                | Retain provider identity in archived metadata even without local messages; recover using provider-owned history after closure. Both provider regressions failed as unavailable, then passed for delivered/absent/unavailable history. |
| Existing enabled workspace loses its recipient on upgrade | Migration binds the sole ordinary conversation, excluding automation workflows. Migration regression failed with null, then passed while ambiguous and automation-only workspaces remained unbound.                                   |
| Failed PR fetch starves siblings and durable events       | Isolate association errors; stop further fetches on rate limits while waking persisted events. Regression failed after only the first fetch, then passed with sibling fetch and queue wake.                                           |
| In-progress CI rerun loses recovery event                 | Deduplicate recovery against the delivered failure identity, independently of the immediately previous CI aggregate. Failure-to-pending-to-success regression failed with no event, then passed exactly once.                         |

All regressions were observed failing before their product fixes. No second
review was dispatched. Provider history that cannot be loaded remains a pause;
restoring that history and explicitly resuming is the documented recovery path.
Local transcript rows never establish receipt.

## Decisions and costs

1. Complete pre-existing multiple-PR prerequisites because the replacement needs
   their identities and collection storage. Cost if wrong: a broader diff.
2. Retain the actual two-minute poll cadence. Cost if wrong: up to two minutes
   of update latency.
3. Persist an observation epoch so re-enabling can seed unchanged actionable
   facts. Cost if wrong: an additional column.
4. Scope historical migration fixtures to their named migration. Cost if wrong:
   later migrations need separate tests, which are provided.
5. Queue foundation changes were integrated before focused tests; their evidence
   is green rather than claimed fail-first. Cost if wrong: weaker regression
   provenance for queue ordering.
6. Demonstrate retention and backup safeguards before schema cutover, following
   automatic approval review. Cost if wrong: task order differs from the plan;
   release remains atomic. Only source and temporary databases were changed.
7. Retire obsolete fixer-dispatch and workspace-branch-rewrite assertions. Cost
   if wrong: lost coverage for intentionally removed behavior.
8. Never retarget a frozen delivery. Recover the old provider receipt, cancel
   only on proven absence after recipient change, and pause otherwise. Cost if
   wrong: explicit recovery is necessary for unreadable history.
9. Pass a backend SHA-256 hasher into the pure shared reducer for persistent
   identity keys. Cost if wrong: persistent callers must use the same hasher.
10. Follow existing subsystem test naming. Cost if wrong: plan example commands
    need corresponding actual file names, which have been updated.
11. Commit the coupled replacement atomically. Cost if wrong: a broader
    implementation commit to review.
12. Retain administrative response fields and Ratchet API names as compatibility
    controls with event-only internals. Cost if wrong: legacy naming persists.

Deferred minor findings: none.

## Verification

Final checks passed: `pnpm check:fix`, `pnpm typecheck`, `pnpm test`,
`pnpm check` and `pnpm check:prisma-schema`. The complete suite passed 526 test
files and 5,971 tests, with one file and four tests skipped. Desktop and mobile
Storybook previews fit correctly, with keyboard recipient selection verified.
The Codex schema drift subcheck is skipped locally because installed CLI 0.160.1
differs from pinned 0.153.4; CI enforces strict schema verification.
