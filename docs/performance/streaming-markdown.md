# Streaming Markdown

The backend flushes assistant text deltas about every 25 ms. The client appends
each delta's chunk to the accumulated message text, producing a new string.
Application Markdown uses Streamdown 2.7.1 with our existing typography, links,
images and Mermaid renderer. The React Markdown primitive remains available as
the comparison baseline.

## Approach

`TranscriptRows` marks the last transcript message, ignoring queued prompts, as
streaming while the agent is running. Only that message's `TextRenderer` changes
behavior:

- **Throttled snapshot.** `useStreamingTextSnapshot` commits the latest text at
  most every 100 ms, always at the trailing edge, so Markdown renders about ten
  times per second rather than forty. When the message stops streaming (the
  agent stops, or another message follows it), the exact text renders in the
  same commit.
- **Streamdown blocks.** Streamdown memoizes completed blocks and reuses stable
  block boundaries for append-only updates. The growing tail still re-parses;
  large code fences, reference definitions and footnotes can require more work.
- **Word fades.** Live replies use 120 ms opacity fades with zero stagger, so
  there is no queued word-reveal delay. Reduced-motion preferences disable
  animation. Completion renders the exact source with incomplete-Markdown
  repairs disabled and removes the animation spans. History renders immediately.

The chosen foreground timing budget is up to 100 ms from client receipt to the
next text snapshot, followed by a 120 ms fade to full opacity. New words begin
fading as soon as that snapshot commits; there is no stagger or word queue. Thus
the nominal budget to full opacity is 220 ms after client receipt, or about 245
ms including the backend's 25 ms batching window. Network transit, Markdown
rendering, a paint frame and main-thread scheduling add to that budget; it is
not a hard wall-clock maximum, particularly for a busy or hidden tab.

Issue #2880 originally proposed an 80–120 ms total visual-delay target for a
queued character-reveal experiment. After trying the comparison, the user chose
these 120 ms word fades with the existing 100 ms parse throttle. That accepted
tradeoff allows a longer time to full opacity while avoiding accumulated reveal
debt. Completed messages flush immediately without waiting for the fade.

The animation stylesheet and Tailwind sources live in `src/client/globals.css`,
so the application and Storybook use the same styling. File navigation, GitHub
previews and image validation remain owned by the application wrapper. Literal
HTML and the existing URL policy are preserved instead of using Streamdown's
default HTML and URL rewriting pipeline.

## React Markdown baseline

The comparison's React Markdown primitive retains its earlier optimization:

- **Block-wise parsing.** `MarkdownRenderer` with `streaming` splits content via
  `splitMarkdownBlocks` (`src/lib/markdown-blocks.ts`) and renders each block as
  a memoized react-markdown tree inside the usual wrapper. Completed blocks skip
  re-rendering; the growing tail block re-parses. When a snapshot crosses a
  block boundary, the former tail re-parses once more with its trailing blank
  lines.

The splitter separates blocks only before an unindented, non-list line after a
blank line, outside a top-level fenced code block (backtick or tilde, with
CommonMark closing-length rules). Indented lines and list markers can continue
lists, loose lists, or indented code, so they never start a new block. Text with
link reference or footnote definitions, or with HTML blocks that may contain
blank lines (`<!--`, `<pre>`, `<script>`, and similar, at a line or container
start), remains a single block. An indented fence may belong to a list item or
the top level; text also remains a single block when a later line would end it
under only one reading. Line-boundary and sampled prefixes of a mixed reply
render the same HTML in either mode
(`src/components/ui/markdown-streaming.test.tsx`).

Finished and historical messages render one block, exactly as before. When
streaming ends, the row re-renders once as a single block. A Mermaid diagram in
a non-first block remounts at that point and renders again.

## Reproduction and measurements

```sh
pnpm exec vitest bench --run --reporter=verbose markdown-streaming
```

The benchmark (`src/components/ui/markdown-streaming.bench.tsx`) renders a
realistic reply of whole sections (closed fences, lists, tables) in jsdom and
measures one delta: the tail paragraph changes while the preceding content stays
the same. Results include jsdom DOM costs.

On macOS arm64 under concurrent load, mean milliseconds per delta:

| Reply size | Single parse | Block parse |
| ---------- | -----------: | ----------: |
| 2 KB       |      2.9–3.4 |   0.15–0.20 |
| 20 KB      |    26.9–34.6 |   0.63–1.03 |

The ranges are the two Vitest projects in one run, not statistical claims. Block
parsing remains proportional to the tail block's size; a single huge fenced
block, or text that falls back to one block, still re-parses fully but at most
ten times per second.

## Streamdown comparison

Storybook's **Chat / Streaming Markdown comparison** runs the React Markdown
baseline and the application's Streamdown adapter from identical snapshots.
Start Storybook with `pnpm storybook`; the stories cover prose, bursty delivery,
a long code fence, tables/diagrams, and application links/images. The snapshot
control offers 25, 50, and 100 ms intervals; the simulated source delivers
chunks every 25 ms. Pause preserves the chunk position, Restart resets the
delivery pattern and snapshot clock, and Finish now settles both panes.

The adapter uses 120 ms word fades with zero stagger. Streamdown's backlog
budget is soft: a nonzero stagger can still schedule seconds of animation for a
large burst. Zero stagger avoids that queue. Reduced-motion preferences disable
the animation, and completed messages remove the animation spans. The production
transcript uses this adapter with the existing snapshot interval.

The optional `renderContent` boundary on the Markdown primitive lets the
comparison reuse our existing file links, GitHub previews, image validation,
Mermaid renderer, and typography. The adapter explicitly replaces Streamdown's
raw-HTML and URL-rewriting defaults with our existing literal HTML and URL
handling. Its semantic element overrides retain native headings, strong text,
and tables. Workspace-navigation callbacks use a committed ref, so opening a
file tab updates the handler without remounting or replaying the text fades.
Other rendering configuration changes remount Streamdown because its root memo
does not observe those options.

Run the comparison benchmark with:

```sh
pnpm exec vitest bench --run --reporter=verbose streamdown-markdown
```

It measures per-update parsing, React, and jsdom DOM work for an approximately
20 KB completed prefix with a growing paragraph and for a growing fenced code
block. Each sample appends a bounded tail and resets every 32 updates, allowing
append-only block reuse without an ever-growing benchmark input. Repeated prose
sections are separated by blank lines; the code case appends complete new lines
inside the open fence. Streamdown's word-span creation is included; browser
animation, layout, paint, scrolling, and visual latency are not. These
measurements cannot establish perceived smoothness or justify removing the
existing throttle by themselves.

On macOS arm64 with Node 26.12.1, a local run on 2026-11-03 reported mean
per-update costs of about 0.48 ms for the React Markdown baseline versus
1.38–1.45 ms for Streamdown with word fades on the completed-prefix fixture. For
the open code fence, the means were 0.59–0.62 ms versus about 0.71 ms. These
ranges are the two Vitest project results from one run, not confidence
intervals. This trial demonstrates a visual option, not a parsing speedup over
our existing block memoization.
