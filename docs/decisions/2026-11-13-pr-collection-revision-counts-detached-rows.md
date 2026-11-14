# The PR collection revision counts detached rows

Originally decided on 2026-11-04 in #3009.

## Context

A workspace's PR associations stream as one collection, and snapshot updates and
reconciliation reads can arrive out of order. Each association row has its own
revision, but a collection also changes when a PR is detached, and an older
projection that still lists that PR must not win.

## Decision

Canonical PR collections carry `prCollectionRevision`, the sum of each retained
association's revision plus one. Detached associations stay in the sum, so
attaching, detaching and reattaching always advance the collection's freshness,
even when the visible collection becomes empty. Public PR lists exclude detached
rows, and reads of attached rows alone omit the collection revision because they
cannot establish the full membership history.

Rejected: deriving freshness from the visible rows only, which an empty
collection cannot order.

## Consequences

- Detaching a PR marks its row detached instead of deleting it.
- Only reads of the whole collection can fence older projections.
