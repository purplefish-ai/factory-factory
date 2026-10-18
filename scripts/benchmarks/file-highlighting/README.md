# File highlighting benchmark

Run from the repository root with its pinned Node and pnpm versions:

```sh
pnpm exec node scripts/benchmarks/file-highlighting/run.mjs \
  --bundle --screenshots=/tmp/file-highlighting-preview \
  > /tmp/file-highlighting-results.json
```

The runner builds a render-comparison fixture and a separate cold-loading
fixture using the existing Playwright Chromium installation, Vite, and
repository dependencies. Build outputs live in a temporary directory and are
removed afterward. It does not start the backend or access a workspace database.
Use `--verify-only` to run browser assertions and optional screenshots without
timing samples. The screenshot flag is optional, as is `--bundle` (which adds
two full frontend builds). Stop other builds and test workloads before comparing
timings.

The production browser build renders the first 100 and 1,000 lines of the actual
GitHub CLI service. It compares the previous inline-styled Prism configuration
against the actual `FileCode` component. Both render line numbers; the worker
renderer groups source into bounded blocks. After verifying the deferred worker,
each case gets three warm-up renders and nine measured renders. JSON includes
every sample and the median synchronous render time, render plus forced layout
time, DOM node count, and inline-styled token count. These measure the
synchronous initial usable-text render and layout. For the worker renderer,
asynchronous coloring and worker completion are excluded from these timings; the
baseline performs highlighting within its measured render.

Before measuring, browser assertions verify light/dark keyword colors, italic
comments, an all-token inline-style scan for every syntax fixture and measured
optimized render, exact source text including whitespace and trailing newlines,
line numbers, monospace font, long-line horizontal scrolling, JSX/TSX expression
leaf colors, nested class-name punctuation, and unknown-language fallback. The
optional screenshot shows both themes for TypeScript, JavaScript, CSS, markup,
JSX, TSX, JSON, and Markdown. Capture enlarges the viewport to fit the entire
matrix, then waits for all 16 samples to finish their workers and display
visible, differently colored CSS token spans. Assertions record these conditions
before saving the image, so pending or offscreen plaintext cannot pass as a
theme preview. Vitest separately covers readable source during loading and after
worker construction, loading, or message failure, plus theme changes without
replacing the mounted code element.

The cold-loading fixture uses the actual `ScrollArea` and `usePersistentScroll`:
for both highlighted code and plaintext, its outer viewport moves 192 pixels,
the `pre` cannot independently scroll, and the outer position restores after
unmounting and remounting the file. The fixture also checks that `text`,
`plain`, `plaintext`, and `txt` render immediately without requesting the
grammar worker. A separate browser page aborts that actual worker request and
requires warmup to reject with a clear timeout. Normal warmup has a 10-second
deadline; the negative check uses a 100-millisecond deadline with a separate
two-second hang guard.

Bundle mode builds the current frontend twice. For the baseline only, a Vite
loader substitutes `file-viewer.tsx` from commit
`fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6`; all other sources and dependencies
stay current. Override that reference with `--baseline=<git-ref>` when
necessary. The runner follows only static manifest imports from each entry and
sums raw JavaScript bytes and each chunk's independently gzipped bytes. Deferred
chunks are excluded from that startup closure; their bytes are downloaded when
code is first opened. These sums describe code transfer, not network request
latency or browser execution time.

The controlled common-language registry explicitly includes JSX, TSX, and
GraphQL; unsupported languages keep numbered plain text. Source remains visible
while the worker loads or if it fails. Plain-text aliases skip the worker
altogether. The enclosing scroll viewport owns horizontal scrolling. Token
colors use scoped One Light and One Dark CSS, including language-specific
selectors. Long lines retain horizontal scrolling. Blocks retain all source
text, and only nearby byte/token-eligible blocks expand into CSS token spans.
Oversized or token-heavy blocks retain plain text; the byte/token limits bound
transfer and DOM expansion.

The following measurements record the earlier lazy main-thread Prism
implementation. The current component retains its CSS themes but uses bounded
worker tokens; rerun this harness for current timings. Worker CPU and temporary
memory still grow with the full source to preserve multiline grammar context.
Transfer and visible DOM expansion are bounded separately; see
[the viewer report](../../../docs/performance/file-viewer.md).

## Measured result

On October 17, 2026, with Node 26.8.1, Vite 8.3.4, React 19.3.0, and headless
Chromium 156.0.8078.4 at 1200 × 800, a paired production run produced:

| Source lines | Previous render + layout | CSS render + layout | DOM nodes, both |
| ------------ | -----------------------: | ------------------: | --------------: |
| 100          |                  54.7 ms |              3.7 ms |           1,041 |
| 1,000        |                 512.0 ms |             38.2 ms |           9,200 |

For 1,000 lines, the synchronous render portion fell from 499.7 ms to 21.0 ms,
and inline-styled tokens fell from 4,128 to zero. The same source, line
wrappers, and DOM node count were retained. Theme fidelity assertions and the
screenshot matrix passed. The benchmark was run after the other observed test
and build processes finished; these absolute timings remain specific to the
machine and browser, and are not test thresholds.

The same run's full frontend builds measured startup static JavaScript at
715,012 → 499,912 gzip bytes (30.1% smaller). The workspace route's static
closure measured 746,149 → 531,115 gzip bytes. This defers code transfer until a
source file is opened; it does not remove the full grammar set from the app.

The browser harness deliberately imports both implementations, so Vite may warn
that its shared Prism module is imported both statically and dynamically. That
artifact measures warm rendering. The separate application builds in bundle mode
measure the actual deferred split.
