# File viewer performance

The file viewer and diff viewer load when their tabs open. File highlighting
uses the diff worker's controlled `refractor` common-language registry, rather
than importing every Prism grammar into the application. Unsupported languages
remain readable as plain text. Whole-file tokenization preserves multiline
comments and strings before tokens are assigned to source lines.

Source is grouped into 128-line blocks. All original text remains in the DOM for
browser find, selection, and copying. An IntersectionObserver expands only
nearby blocks into colored token spans. Offscreen blocks retain plain text and
the same line heights. Existing persistent viewport scroll handling is retained.
Worker creation, parsing, or execution failures leave usable plain text.

## Reproduction and measurements

Run `pnpm exec vite`, then in another terminal:

```sh
node scripts/benchmarks/file-viewer.mjs http://127.0.0.1:5173/
```

The benchmark needs installed Google Chrome. It compares synchronous React
commits with the old full-Prism renderer against the new file renderer using the
same TypeScript source. It checks complete source equality after the worker
response and checks that syntax spans appear. It records scroll extent and block
count. This measures initial usable text, not completion of highlighting. The
old renderer is imported only by the benchmark fixture, outside app sources.

On macOS arm64, Node 26.8.1, headless Chrome, in development mode:

| Source          | Full Prism commit | Block renderer commit |
| --------------- | ----------------: | --------------------: |
| 100,000 bytes   |          534.6 ms |                5.6 ms |
| 1,000,000 bytes |        4,110.3 ms |               25.8 ms |

These are single local samples during concurrent builds, not statistical claims.
A previous run measured 457.6/3.3 ms and 3,953.8/20.0 ms respectively. The 1 MB
fixture uses 326 blocks, retaining all source text.

The production main chunk decreased from 1,869.37 KB (570.83 KB gzip) to 557.58
KB (159.60 KB gzip). The file viewer chunk is approximately 6 KB and the
highlight worker approximately 240 KB. `pnpm build` checks independent raw-byte
budgets: entry 650 KB, file viewer 20 KB, highlight worker 300 KB. These budgets
cover these modules rather than unrelated deferred Mermaid diagram bundles.
