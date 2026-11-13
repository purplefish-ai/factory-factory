# Observations read only core PR facts while monitoring is off

Originally decided on 2026-11-03 in #2860.

## Context

PR monitoring is off by default, yet the stale-data scheduler and the other
automatic refresh paths still ran the full observation for every attached PR:
the core PR read plus identity, review, inline-comment and review-thread reads.
Only the event reducer uses the review data, and it creates no events while
monitoring is off. With 30 open PRs that was roughly 40 avoidable `gh` spawns
per minute against the user's token budget.

## Decision

While a workspace's monitoring is off, an observation makes only the core read
(one `gh pr view`) and reports reviews as incomplete. The review decision shown
in the UI is a core fact, so the display is unchanged.

## Consequences

- Enabling monitoring always renews the observation epoch. A core-only
  observation still in flight is rejected at acceptance, and the new epoch's
  first observation (the toggle's immediate check or the next poll) reads
  reviews and becomes the baseline.
- An observation already in flight when monitoring turns off may finish its
  review reads; it is accepted without creating events.
