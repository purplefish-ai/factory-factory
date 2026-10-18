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
