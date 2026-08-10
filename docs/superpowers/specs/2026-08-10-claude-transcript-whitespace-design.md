# Claude Transcript Whitespace Design

## Problem

Claude ACP sessions emit `usage_update` events that Factory Factory translates into agent
`result` messages with object-valued `result` payloads. These messages must remain in transcript
state because the reducer uses them to maintain usage statistics, including after hydration.

The result renderer intentionally displays only string-valued results. Object-valued usage results
therefore render no content, but each still reaches the message list and receives virtual-row and
message-wrapper padding. The reported workspace contains 16 such events, producing a large amount
of blank vertical space. Codex transcripts do not currently emit these result events, which is why
their rendering looks correct.

## Design

Filter non-renderable result messages in the shared `groupAdjacentToolCalls` rendering-preparation
function. A result message is renderable only when its `result` is a non-empty string. All other
message types continue through the existing grouping logic unchanged.

This boundary is shared by live workspace chat, quick chat, closed-session transcripts, and
sub-agent transcripts, so one change fixes every transcript surface without duplicating filtering
rules in individual React components.

The filter runs before tool-sequence boundary handling. As a result, usage telemetry arriving
between a tool-use event and its tool-result event will not split the pair. The existing late-result
pairing behavior remains supported.

## Data and Behavior

- Object-valued usage results remain in reducer and persisted transcript state.
- Token and cost statistics continue to update and hydrate from those messages.
- Telemetry-only and empty result messages produce no grouped rendering item and therefore no
  padded or virtualized row.
- Non-empty string result messages remain visible through the existing result renderer.
- Tool-use and tool-result messages separated only by usage telemetry remain one paired tool
  sequence.

No backend protocol, persistence, database, or provider-specific branching changes are required.

## Testing

Add focused unit coverage around `groupAdjacentToolCalls`:

1. An object-valued usage result is excluded from grouped rendering output.
2. A non-empty string result remains in grouped rendering output.
3. A usage result between matching tool-use and tool-result messages does not split the sequence,
   and the paired call retains its completed status and result.

Run the focused test file, then the relevant client/protocol tests, TypeScript checks, and standard
repository guardrails.
