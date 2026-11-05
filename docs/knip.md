# Unused code checks

`pnpm knip` continues to enforce unused files, dependencies and unlisted imports
across application code, tests, stories, CSS, MDX and Prisma. The separate
`pnpm check:unused-code` check compares two analyses against the reviewed
inventory in `scripts/unused-code-baseline.json`. It runs in `pnpm check`, CI
and the pre-commit hook.

## Two different signals

- **Production files:** `knip --production --include files` finds files outside
  the graph reachable from production entrypoints. A test import cannot keep an
  abandoned implementation alive in this analysis. Findings can also be useful
  test support, Storybook fixtures or build inputs; absence from the production
  graph does not by itself justify deletion.
- **Export visibility:** `knip --include exports,types` analyzes the full graph,
  including tests and stories. It reports value and type exports with no
  external consumers. `ignoreExportsUsedInFile: true` removes same-file uses
  from this signal. This narrows the visibility inventory; an implementation
  exported only for same-file use is not confirmed dead. An unused re-export on
  a barrel does not mean its underlying implementation is unused. Namespace
  member and enum member audits are outside this stage.

The entry exports themselves use Knip's default treatment: runtime roots are
entrypoints rather than APIs to trim. Feature, service and shared/core barrels
remain visible to the export audit. Maintained shadcn APIs remain visible too;
there are no blanket directory or export exclusions.

## Runtime roots and Knip 6 semantics

Both manual **entry** patterns and **project** patterns need a trailing `!` to
participate in production mode. In Knip 6, marking just the entries can produce
an empty production file report because unmarked project globs are negated. The
installed Knip `dist/WorkspaceWorker.js` methods
`getProductionEntryFilePatterns` and `getProductionProjectFilePatterns`, and
`dist/util/glob.js`, implement this behavior. `pnpm exec knip --help` documents
`--production` and the JSON reporter. Keep the actual-analyzer regression tests
when upgrading Knip; do not infer production behavior from the normal scan.

`knip.json` explicitly lists these production roots:

- Backend standalone bootstrap (`src/backend/index.ts`), server and migration.
- `ff` CLI (`src/cli/index.ts`).
- Electron main, preload and backend utility-process entry.
- Workspace MCP server, which is spawned separately from the backend graph.
- Browser bootstrap (`src/client/main.tsx`) and diff highlighting Web Worker.

React lazy routes and viewers remain reachable through static `import()`
expressions from the browser bootstrap. They are deliberately not independent
roots: removing the last runtime reference should make them candidates. The Web
Worker is an explicit root because it is launched through `new URL()`; backend
orchestration workers remain ordinary imports from the backend graph. Tests and
stories stay development entrypoints through the Vitest and Storybook plugins.
Test-support files remain individually inventoried rather than hidden with
directory ignores.

`scripts/check-unused-code.test.ts` runs the installed Knip binary against
isolated fixtures using the real entry/project configuration. It proves
production-only reachability catches a test-only module, tests dependencies from
every runtime root and a lazy import, and distinguishes barrel export visibility
from file reachability. A repository positive control also checks that the live
GitHub previews, Markdown renderer, lazy file/diff viewers and critical runtime
modules are absent from the production candidate report. Test-only module and
fixture-support cases share one fixture and one scan per analysis mode. The CLI
report and failure smoke tests still invoke the real analyzer, including the
normal enforcement and update-refusal paths. Additional inventory decisions
exercise the same evaluator directly without repeating analyzer scans.

## Staged review policy

The inventory is a reviewed **signal inventory**, not a list of confirmed dead
implementations. Each stable key has a disposition and rationale:

- `maintained-api`: intentional component or architecture boundary surface.
- `test-support`: fixtures, harnesses or visual scenarios kept for verification.
- `build-input`: verification or bundler input outside the runtime graph.
- `review-required`: a candidate still needing caller, schema or runtime review
  before narrowing exports or deleting an implementation.

This first stage preserves existing candidates, including unresolved ones,
without turning the entire audit into failing CI. CI rejects **new keys** so new
debt needs explicit review; it also rejects **stale keys** so resolved debt
cannot accumulate in the inventory. Export keys use `file::exports::symbol` or
`file::types::symbol`; file keys use repository-relative paths. Line numbers are
intentionally excluded, so unrelated edits do not invalidate review.

```sh
pnpm check:unused-code          # enforce only inventory drift
pnpm check:unused-code:report   # nonblocking JSON findings, reasons and drift
pnpm check:unused-code:update   # prune resolved entries; refuses new keys
pnpm test scripts/check-unused-code.test.ts --maxWorkers=2
```

The report command exits successfully for candidate debt; analyzer failures,
invalid JSON and unexpected report/baseline schemas still fail. The normal check
accepts Knip's finding exit code only with a valid nonempty report and fails on
process errors, signals and timeouts. The commands do not run Knip fixes or
remove source files.

When a new candidate appears, inspect runtime imports, dynamic launch paths,
barrels and schema/type contracts. Fix a missing real root or remove confirmed
unneeded code where appropriate. If the API or candidate must remain, add its
exact key with a specific disposition and reason in the same reviewed PR. There
is no automatic command to accept new debt. After a cleanup or rebase, run the
update command to prune resolved entries, inspect its diff, then rerun the
check. The initial inventory was refreshed against merged audit cleanups; its
`review-required` entries remain follow-up work, not deletion instructions.

## Dependency and component maintenance

Unused shadcn primitives and their exclusive dependencies were removed in
September 2026. The UI directory has no file exclusions: keep components with
application or Storybook consumers, and add others when needed.

The only dependency exclusion is `@prisma/client`, imported by generated Prisma
runtime code; it must remain a production dependency. Knip follows
`tw-animate-css` and `@tailwindcss/typography` in `src/client/globals.css`, and
detects the `@agentclientprotocol/claude-agent-acp` executable dependency. These
packages remain in dependency analysis.

See [shadcn maintenance](shadcn.md) for component refresh and local adaptations.
