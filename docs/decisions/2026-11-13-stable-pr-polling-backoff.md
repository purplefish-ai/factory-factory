# Unforced observations back off PRs whose facts stopped changing

Originally decided on 2026-11-09 in #3123.

## Context

A measured sample of the live server showed PR monitoring spawning `gh` for
every open PR on every two-minute poll, although most open PRs sit unchanged for
hours: CI finished, reviews read, nobody pushing. Facts change mainly when an
agent pushes or a human reviews or merges.

## Decision

An open PR is settled when its CI is terminal (`SUCCESS` or `FAILURE`) and,
while monitoring is on, its review facts are complete. After three consecutive
identical observations of a settled PR (ignoring the observation time), unforced
observations keep the committed facts until 10 minutes have passed since the
last GitHub read.

The PR returns to the normal cadence when an observation changes, another writer
changes its revision, a forced observation runs, or a session in the workspace
starts or finishes a turn, since that is when an agent pushes. The state lives
in memory beside the 90-second reuse window, so a restart starts every PR at the
normal cadence.

GitHub's `updatedAt` is not used to skip reads: it is not known to change when a
review thread is resolved, so it could hide a change the ledger needs.

## Consequences

- A change made on GitHub while a PR is backed off, such as a new human review
  or a merge in the web UI, can take up to 10 minutes to be observed.
- Pending or unknown CI and incomplete reviews never back off.
