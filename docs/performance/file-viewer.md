# File viewer performance

The file viewer and diff viewer load when their tabs open. File highlighting
uses the diff worker's controlled `refractor` common-language registry plus
explicit JSX, TSX, and GraphQL grammars. It avoids importing every Prism grammar
into the application. Unsupported languages remain readable as plain text.
Whole-file tokenization preserves multiline comments and strings before tokens
are assigned to source lines.

Source is grouped into 128-line blocks. A block expands into syntax spans only
when its source is at most 32 KiB of UTF-8 and its highlighted output contains
at most 4,096 tokens. Larger or token-heavy blocks retain exact plain text; the
worker omits their tokens before transfer. Files containing only oversized
blocks skip the worker entirely. The UI byte-budget preflight cannot predict
token count: byte-eligible but token-heavy blocks still require worker
tokenization before falling back to plain text. Whole-file tokenization still
preserves multiline context for eligible blocks after an oversized block. All
original text remains in the DOM for browser find, selection, and copying. An
IntersectionObserver expands only nearby blocks into colored token spans.
Offscreen blocks retain plain text and the same line heights. Existing
persistent viewport scroll handling is retained. Worker creation, parsing, or
execution failures leave usable plain text. Token and viewport changes wait
while their block contains selected text, so scrolling a native find result into
view preserves its selection. Coloring resumes after that selection is cleared.

For files that start a worker, it tokenizes the entire source and builds tokens
for every line before filtering blocks. CPU work and temporary worker memory
therefore grow with the full file and grammar complexity, rather than the
visible range; the byte/token budgets bound transfer and DOM expansion, not
tokenizer cost. Keeping whole-file context preserves comments and strings
spanning block boundaries. The source remains readable while this background
work completes.

## Reproduction and measurements

Run `pnpm exec vite`, then in another terminal:

```sh
node scripts/benchmarks/file-viewer.mjs http://127.0.0.1:5173/
```

The optional argument accepts only an HTTP(S) origin (with an optional trailing
slash), without a path prefix, query, hash, or credentials. Other inputs fail
before Chrome launches. The fixture is served at
`/scripts/benchmarks/file-viewer.html` from that origin; use the normal
root-mounted Vite development server.

The benchmark needs installed Google Chrome. It compares synchronous React
commits with the old full-Prism renderer against the new file renderer using the
same TypeScript source. It checks complete source equality after the worker
response and checks that syntax spans appear. It records scroll extent, visible
block numbers, and block count. Minified JSON cases also check bounded DOM size,
worker completion or avoidance, exact native selection, browser find, and
horizontal scrolling. This measures initial usable text, not completion of
highlighting. The old renderer is imported only by the benchmark fixture,
outside app sources.

On macOS arm64, Node 26.8.1, headless Chrome, in development mode:

| Source          | Full Prism commit | Block renderer commit |
| --------------- | ----------------: | --------------------: |
| 100,000 bytes   |          209.4 ms |                3.7 ms |
| 1,000,000 bytes |        3,076.7 ms |               14.2 ms |

These are single local samples during concurrent builds, not statistical claims.
A previous run measured 431.4/3.4 ms and 3,948.4/22.2 ms respectively. The 1 MB
fixture uses 326 blocks, retaining all source text.

Minified JSON measured 0.3 ms at 7,997 bytes, 0.2 ms at 99,997 bytes, and 0.4 ms
at 999,997 bytes. Each retained three DOM descendants under the `pre` element.
The 8 KB case completed its worker and fell back under the token budget; the 100
KB and 1 MB cases created no worker. Full text, native copy/find, and horizontal
scrolling passed in all three cases.

The production main chunk decreased from 1,869.37 KB (570.83 KB gzip) to 572.62
KB (163.68 KB gzip). The file viewer chunk is approximately 7 KB and the
highlight worker approximately 246 KB. `pnpm build` checks independent raw-byte
budgets: entry 650 KB, file viewer 20 KB, highlight worker 300 KB. These budgets
cover these modules rather than unrelated deferred Mermaid diagram bundles.
