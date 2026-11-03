# Streaming Markdown

The backend flushes assistant text deltas about every 25 ms. Each delta replaces
the streaming message's text. Previously, the transcript row re-parsed the whole
reply with react-markdown and remark-gfm on every delta. Per-reply work grew
quadratically with its length, and long replies saturated the main thread.

## Approach

`TranscriptRows` marks the last transcript message as streaming while the agent
is running. Only that message's `TextRenderer` changes behavior:

- **Throttled snapshot.** `useStreamingTextSnapshot` commits the latest text at
  most every 100 ms, always at the trailing edge, so Markdown renders about ten
  times per second rather than forty. When the message stops streaming (the
  agent stops, or another message follows it), the exact text renders in the
  same commit.
- **Block-wise parsing.** `MarkdownRenderer` with `streaming` splits content via
  `splitMarkdownBlocks` (`src/lib/markdown-blocks.ts`) and renders each block as
  a memoized react-markdown tree inside the usual wrapper. Completed blocks skip
  re-rendering; only the growing tail block re-parses.

The splitter separates blocks only before an unindented, non-list line after a
blank line, outside a top-level fenced code block (backtick or tilde, with
CommonMark closing-length rules). Indented lines and list markers can continue
lists, loose lists, or indented code, so they never start a new block. Text with
link reference or footnote definitions, or with HTML blocks that may contain
blank lines (`<!--`, `<pre>`, `<script>`, and similar), remains a single block.
Each streaming prefix of a mixed reply renders the same HTML in either mode
(`src/components/ui/markdown-streaming.test.tsx`).

Finished and historical messages render one block, exactly as before. When
streaming ends, the row re-renders once as a single block. A Mermaid diagram in
a non-first block remounts at that point and renders again.

## Reproduction and measurements

```sh
pnpm exec vitest bench --run --reporter=verbose markdown-streaming
```

The benchmark (`src/components/ui/markdown-streaming.bench.tsx`) renders a
realistic reply in jsdom and measures one delta: the tail paragraph changes
while the preceding content stays the same. Results include jsdom DOM costs,
which are higher than in a browser.

On macOS arm64 under heavy concurrent load, mean milliseconds per delta:

| Reply size | Single parse | Block parse |
| ---------- | -----------: | ----------: |
| 2 KB       |    15.5–29.6 |     1.1–1.1 |
| 20 KB      |  151.5–225.1 |     2.7–5.1 |

The ranges are the two Vitest projects in one run, not statistical claims. Block
parsing remains proportional to the tail block's size; a single huge fenced
block, or text that falls back to one block, still re-parses fully but at most
ten times per second.
