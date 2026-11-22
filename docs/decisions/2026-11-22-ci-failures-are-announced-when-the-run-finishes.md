# CI failures are announced when the run finishes

Decided on 2026-11-22 in #3288.

## Context

`ciStatus` is `FAILURE` as soon as one check fails, even while others are still
running. The reducer announced a failure on that first observation and again
each time the set of failing checks changed, so one push whose checks failed one
after another could send the agent several `CI_FAILED` updates, each costing a
turn and describing a run that was still changing.

## Decision

A failure is announced once no check of the run is still in progress
(`isSettledPRFailure` in `src/shared/pr-trigger-policy.ts`), or once it has
waited for the limit below. Until then the reducer queues nothing for it.

A check can stay in progress indefinitely: a job awaiting an environment
approval, or a required status that nobody reports. So an unchanged failure
waits at most 30 minutes (`PR_FAILURE_MAX_WAIT_MS`) and is then announced with
the checks that have failed so far.

The reducer compares each observation only with the previous one, and a failing
run can pass through "still running" between two announcements (another check is
re-run) or before its first. The stored observation therefore records, as
`ciFailure`, when its failure (the same head and failing checks) was first
observed and whether it has been announced. Only the stored observation's schema
has the field, so a fetched observation or a fact cannot carry it; a stored
failure without it predates the field and counts as announced, which is what the
earlier rule did.

Pinned by `src/shared/pr-trigger-policy.test.ts` and, over random histories,
`src/shared/pr-trigger-policy.property.test.ts`.

`CI_RECOVERED` is unchanged: it reports a passing run on the head whose failure
was delivered, and a passing run has no check in progress.

## Consequences

- An update names every check that failed in the run, and arrives after the
  slowest check finishes rather than after the first failure.
- A failing run with a check in progress is not "settled" for the
  [stable polling backoff](2026-11-13-stable-pr-polling-backoff.md), so the read
  that finds the run finished is not delayed. A run that never finishes is
  therefore polled at the normal cadence, as a run with no failure already was.
- A run that takes more than 30 minutes after a failure can yield two updates:
  one at the limit, and one when a later check also fails.
