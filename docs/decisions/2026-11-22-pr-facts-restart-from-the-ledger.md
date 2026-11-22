# Without a baseline, PR facts restart from the ledger

Decided on 2026-11-22 in #PR_NUMBER.

## Context

`reducePRObservation` in `src/shared/pr-trigger-policy.ts` states a fact when an
observation differs from the stored previous one. Two kinds of observation had
no previous one it could use, although the epoch's ledger was not empty:

- A reopened PR. A closure supersedes every queued fact except itself, and the
  stored observation is then the closed one. A failure, conflict or open thread
  that still held at the reopening showed no change, so a fact that was queued
  but undelivered at the closure was lost.
- A stored observation of the current epoch that another build wrote and this
  one cannot parse. The accessor passes `previous: null`, and the reducer took
  the observation for the first of an epoch and restated every fact that held,
  including the ones the recipient had already received.

## Decision

When `previous` is null, or merged or closed while the PR is open, the
comparison restarts: every fact that holds now is stated unless the ledger of
this epoch (queued, in-flight and delivered facts) shows the recipient was told
it or has it queued. Per kind:

- A failure, when it is due under the
  [announcement rule](2026-11-22-ci-failures-are-announced-when-the-run-finishes.md),
  is stated unless the last `CI_FAILED` or `CI_RECOVERED` the ledger holds for
  this head is a `CI_FAILED` with the same failing checks. On a restart the
  ledger, not the stored `ciFailure.announced`, decides whether it was
  announced: a closure supersedes a queued announcement the memory still counts,
  and a lost baseline forgets a delivered one. `ciFailure.since` is still
  carried from a closed baseline, so the wait does not start again on a
  reopening.
- A conflict detection is stated unless the last conflict fact the recipient got
  is a detection, or a detection is queued; a clearance, symmetrically, when it
  believes the PR is conflicted and no clearance is queued. The queue then
  agrees with what the recipient believes.
- Feedback is stated unless the same review (identity and content hash) was
  delivered, or is queued or in flight for this head. Feedback in flight for an
  earlier head is stated again, as it is after a push, because a cancelled claim
  would otherwise lose it.
- A merge or closure with no baseline is stated unless the ledger holds the fact
  the current transition sequence produced: a key embeds the sequence, so a
  match means no transition followed it. A reopening advances the sequence even
  without a baseline (the ledger holds the closure of the current sequence), so
  a later closure is a new fact.

When the baseline is lost on an incomplete review read, the stored observation
keeps the feedback the ledger states, as an incomplete read keeps the feedback a
baseline held, so the next complete read does not take it for new.

The ledger counts only rows keyed for this epoch and PR. The accessor reads no
other, so in production a new epoch has an empty ledger and states everything,
as before. A row keyed for another epoch describes what an earlier destination
was told, which the new one was not.

Pinned by `src/shared/pr-trigger-policy.test.ts` and, over random histories that
now close, reopen and lose the stored observation,
`src/shared/pr-trigger-policy.property.test.ts`.

Keeping a separate "reopened" or "unreadable" path for each case was rejected:
both lack a usable baseline, and the ledger answers the same question for both.

## Consequences

- A thread that was resolved and re-opened with the same text while the baseline
  was unreadable is not stated again; the ledger cannot show the resolution.
- A failure still running when the baseline is lost waits the full 30 minutes
  again before it is announced, unless the ledger shows it was announced.
- With a baseline, a failure can still be announced twice on one head: after it
  is delivered, another check fails, that announcement is superseded undelivered
  when the check is re-run and passes, and the earlier failure is announced
  again. This change does not alter that path.
