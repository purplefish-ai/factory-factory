# File highlighting benchmark

Run from the repository root with its pinned Node and pnpm versions:

```sh
pnpm exec node scripts/benchmarks/file-highlighting/run.mjs \
  --bundle --screenshots=/tmp/file-highlighting-preview \
  > /tmp/file-highlighting-results.json
```

The runner uses the existing Playwright Chromium installation, Vite, and
repository dependencies. Build outputs live in a temporary directory and are
removed afterward. It does not start the backend or access a workspace database.
Use `--verify-only` to run browser assertions and optional screenshots without
timing samples. The screenshot flag is optional, as is `--bundle` (which adds
two full frontend builds). Stop other builds and test workloads before comparing
timings.

The production browser build renders the first 100 and 1,000 lines of the actual
GitHub CLI service. It compares the previous inline-styled Prism configuration
against the actual `FileCode` component. Both render line numbers and line
wrappers. After loading the deferred highlighter, each case gets three warm-up
renders and nine measured renders. JSON includes every sample and the median
synchronous render time, render plus forced layout time, DOM node count, and
inline-styled token count. These are warm render measurements; the initial
numbered plaintext fallback and subsequent chunk download are not timed.

Before measuring, browser assertions verify light/dark keyword colors, italic
comments, exact source text including whitespace and trailing newlines, line
numbers, monospace font, long-line horizontal scrolling, absence of inline token
styles, and unknown-language fallback. The optional screenshot shows both themes
for TypeScript, JavaScript, CSS, markup, JSON, and Markdown. Vitest separately
covers readable source during loading and after chunk-load failure, plus theme
changes without replacing the mounted code element.

Bundle mode builds the current frontend twice. For the baseline only, a Vite
loader substitutes `file-viewer.tsx` from commit
`fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6`; all other sources and dependencies
stay current. Override that reference with `--baseline=<git-ref>` when
necessary. The runner follows only static manifest imports from each entry and
sums raw JavaScript bytes and each chunk's independently gzipped bytes. Deferred
chunks are excluded from that startup closure; their bytes are downloaded when
code is first opened. These sums describe code transfer, not network request
latency or browser execution time.

The optimization preserves the full Prism language set and keeps numbered source
visible while the chunk loads or if it fails. Token colors use scoped One Light
and One Dark CSS, including language-specific selectors. Long lines retain
horizontal scrolling. There is no virtualization or file-size policy change;
very large files still create a DOM node for every rendered token.

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
