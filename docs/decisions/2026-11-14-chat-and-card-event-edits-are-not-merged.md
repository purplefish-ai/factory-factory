# Chat and card event edits are not merged

Originally decided on 2026-10-31 in #2750.

## Context

An automation proposal can change from two sides at once. The agent revises it
in chat, which writes a new revision; the user edits the same proposal in its
card. When the card receives the newer revision it has to combine the two.
Events are a list, and each event carries its own source and filter.

## Decision

When both sides changed the events, the card stops loading the newer revision
and keeps the local edits until the user explicitly discards them. Local values
win for the other fields edited on both sides.

Rejected: merging the two event lists by position. A positional merge could
attach a filter written for one source to a different source.

## Consequences

- The user sees a message and decides; nothing is merged silently.
- Conversational changes to fields the user did not touch still load.
