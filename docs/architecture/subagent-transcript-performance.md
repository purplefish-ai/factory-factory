# Subagent transcript projection performance

Subagent transcript pages are translated through `AcpEventTranslator` and the
chat reducer. Provider message IDs do not merge chunks: projection assigns each
translated event a monotonically increasing order. Terminal tool updates append
results; partial updates retain the existing translator behavior.

Projection collects completed messages in a page-local array. The reducer sees
only one update at a time, or one contiguous thought sequence, rather than the
entire growing page. A thought sequence keeps its seed until the sequence ends,
so the reducer still accumulates thought deltas exactly as in live chat. The
final pass assigns deterministic IDs and timestamps to every collected message.

This bounded working set relies on the current `SubagentTranscriptUpdate`
variants: user chunks, assistant chunks, thought chunks, tool calls, tool
updates, and plans. If a new variant introduces updates to earlier message
orders or cross-message result deduplication, review this boundary before
projecting it. The live chat reducer, subagent page cache, and page boundaries
are unchanged.

## Repeatable benchmark

From a checkout with the pinned dependencies and Node version:

```sh
pnpm exec vitest run --config scripts/bench-subagent-transcript.config.ts
```

The benchmark config uses production mode. Each case contains ten user turns,
pending tool calls, completed tool updates with 512-byte outputs, and an
assistant text chunk after each tool. It warms up three times and prints nine
samples plus their median for 5, 25, and 100 tools per turn (160, 760, and 3010
updates). Copy the benchmark script and config unchanged to a baseline checkout
when comparing revisions. Keep other CPU-heavy tasks idle for measurements.

The regression test counts actual collected-message traversal work for a
750-update page instead of enforcing a machine-dependent time limit. Semantic
tests cover deterministic IDs and timestamps, reasoning boundaries, reused tool
IDs, partial inputs, terminal content, and independent pages.

## Recorded comparison

On 2026-10-17, Apple M4 / Node 26.8.1 production-mode projection produced these
medians against the pre-change implementation from
`fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6`:

| Updates |    Before |   After |
| ------- | --------: | ------: |
| 160     |   1.84 ms | 0.46 ms |
| 760     |  37.43 ms | 2.35 ms |
| 3010    | 590.50 ms | 8.19 ms |

The comparison alternated execution order over 15 pairs after three warm-up
pairs, using the same ten-turn fixtures described above. Every pair compared the
complete projected message arrays for equality, including IDs, orders,
timestamps, and content. Other work on the shared host caused some sample
variation; these are local measurements, not CI performance thresholds.
