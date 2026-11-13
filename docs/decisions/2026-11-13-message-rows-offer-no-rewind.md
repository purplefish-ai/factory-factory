# Message rows offer no rewind

Originally decided on 2026-11-09 in #3103.

## Context

Message rows once carried a rewind action with a confirmation dialog, and the
reducer tracked message UUIDs for it. The ACP runtime does not support rewinding
files: the backend always reported rewind as disabled, and the client could only
answer the action with an "unsupported" error.

## Decision

Message rows offer no rewind action, and the client keeps no rewind state.
`capabilities.rewind` stays on the wire and is always disabled.

## Consequences

- The client sends no rewind request; the chat message schema rejects the
  retired `rewind_files` type.
- User and assistant message rows have no copy buttons; copying them uses native
  text selection. Error lifecycle rows keep their own copy action.
