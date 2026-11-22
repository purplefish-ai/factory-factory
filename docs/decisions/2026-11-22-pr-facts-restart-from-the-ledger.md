# Without a baseline, PR facts restart from the ledger

Decided on 2026-11-22 in #3289.

## Context

`reducePRObservation` in `src/shared/pr-trigger-policy.ts` states a fact when an
observation differs from the stored previous one. Two kinds of observation had
no previous one it could use, although the epoch's ledger was not empty:

- A reopened PR. A closure supersedes every queued fact except itself, so a
  failure, conflict or open thread queued but undelivered at the closure showed
  no change against the closed observation and was lost.
- A stored observation another build wrote and this one cannot parse. The
  accessor passes `previous: null`, and the reducer restated every fact that
  held, including the ones already delivered.

## Decision

When `previous` is null, or merged or closed while the PR is open, the
comparison restarts: every fact that holds now is stated unless this epoch's
ledger (queued, in-flight and delivered facts) shows the recipient was told it
or has it queued. The reducer's comments give the rule for each kind. Two parts
are not obvious:

- On a restart the ledger, not the stored `ciFailure.announced`, says whether a
  failure was announced: a closure supersedes a queued announcement that the
  memory still counts, and a lost baseline forgets a delivered one.
- A closure is recognised by the key of the current transition sequence, so a
  reopening advances the sequence even without a baseline and a later closure is
  a new fact.

The ledger counts only rows keyed for this epoch and PR. The accessor reads no
other, so a new epoch states everything, as before.

The same question settles one case with a baseline. When the stored observation
is failing on the same head with other failing checks, CI kept failing while the
set changed. If the last CI fact the recipient was told for the head (delivered
or in flight) is a `CI_FAILED` with the current checks, the failure counts as
announced: the announcement of the set in between was superseded before it
arrived, and the recipient already believes what fails now. Before, a delivered
failure that another check joined and a re-run cleared was announced twice. This
holds when a recovery came in between and was superseded undelivered: the
recipient never heard of it, and believes what is true again.

The rule needs a failing stored observation. After CI passed or was pending the
failure is announced afresh, even with the same checks: commit statuses carry no
timestamps, so a failure can recur identically, and the queued recovery it
supersedes leaves the old `CI_FAILED` last in the ledger. Checking the ledger
there would suppress a real new failure.

Pinned by `src/shared/pr-trigger-policy.ledger.test.ts` and
`src/shared/pr-trigger-policy.property.test.ts`, whose histories now close,
reopen and lose the stored observation, and which checks that no `CI_FAILED`
reports the failure the recipient was last told of for its head.

Separate paths for "reopened" and "unreadable" were rejected: both lack a usable
baseline, and the ledger answers the same question for both.

## Consequences

- A thread resolved and re-opened with the same text while the baseline was
  unreadable is not stated again; the ledger cannot show the resolution.
- A failure still running when the baseline is lost waits the full 30 minutes
  again, unless the ledger shows it was announced.
- A failure that recurs with identical checks after CI passed is announced
  again, even when the recovery never reached the recipient.
