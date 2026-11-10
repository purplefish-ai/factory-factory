# Lint and formatting guardrails

[Oxlint](https://oxc.rs/docs/guide/usage/linter.html) runs the JavaScript and
TypeScript checks in `.oxlintrc.json`, including native type-aware floating and
misused promise checks through the pinned `oxlint-tsgolint` engine. The root
`options.typeAware` setting applies to the CLI and the Oxc editor extension.
Biome preserves the existing hook order, exhaustive dependencies and remaining
checks, including its promise coverage while equivalence is still evaluated. The
repository already uses the TypeScript 7 compiler via `@typescript/native` while
keeping the TypeScript 6 JavaScript API for tooling.

[Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) owns formatting and
import sorting. `.oxfmtrc.json` keeps two-space indentation, single quotes,
semicolons, ES5 trailing commas and a 100-column source width. Markdown wraps
prose at 80 columns and preserves fenced code. Generated Prisma files and the
pnpm lockfile are excluded. Both `@/` and `@prisma-gen/` are explicitly
classified as internal imports. Side effect imports keep their execution order;
formatting preserves unused imports for the linter to report.

`scripts/oxfmt-config.test.ts` runs the pinned formatter against source, CSS,
JSON and Markdown fixtures, including generated-file exclusions and fenced-code
preservation. To hide the import-only conversion from blame, run
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Custom rules

`factory.mjs` replaces the enabled Grit rules with Oxlint's ESLint-compatible
plugin API. That API remains alpha: keep exact tool pins and real-binary
fixtures when upgrading it. The rules require accessible names for icon-only
buttons (including the shared `Button` icon sizes), and reject awaited dynamic
imports, native browser dialogs, Next.js directives, `z.any()`/`zod.any()`,
assertions on `JSON.parse` results, casts of promise resolvers to function types
accepting `unknown`, type assertions on agent tool input (`input.todos as …`,
`call.input.file_path as …`) under `src/client/features/chat/agent-activity`,
which must use `parseToolInput` with a Zod schema, and fixed Tailwind palette
color classes (`bg-red-500`, `dark:text-emerald-300`) in `src/client`,
`src/components` and `src/lib`, which must use theme tokens instead
([status colors](../docs/status-colors.md)). The palette rule's file exceptions
are its `exceptions` option, a map from path to reason in `.oxlintrc.json`; a
test fails if an exception no longer needs it. `use-pending-prop` rejects a
`Spinner`, `SpinnerGapIcon` or `animate-spin` element inside `Button` or
`DropdownMenuItem`, which take `pending` instead, and `no-raw-spinner` rejects a
bare `SpinnerGapIcon` and `animate-spin` outside the shared `Spinner`
([pending controls](../docs/architecture/client-loading.md#pending-controls)).
Each takes its own `exceptions` map in the same shape; their test lints each
listed file with the rule and no exceptions and fails once a file stops
reporting. `query-owner` keeps tRPC hooks and cache helpers for named procedures
inside owner modules. Each entry in its `groups` option lists procedures, the
module callers should `use`, its `owners` (that module and its helpers), the
reason, and which helpers it covers: `cache` covers helpers that install options
or write data (`useQuery`, `fetch`, `setData` and similar) plus `getQueryKey`,
and `all` covers every hook, cache helper and key helper, including
`useMutation`. `workspace.get` and `workspace.listForProject` use `cache`, so
every read installs the snapshot reconciler
([workspace state](../docs/architecture/workspace-state.md)). `userSettings.get`
and `userSettings.update` use `all`: settings are read and written only through
`useUserSettings` and `useUpdateUserSettings` in
`src/client/lib/user-settings-queries.ts`, which own the optimistic cache
strategy and error toast. Tests are exempt so they can seed caches.
`named-query-options` keeps query options in one place
([query retries and polling](../docs/architecture/client-loading.md#query-retries-and-polling)):
it rejects a numeric `refetchInterval` literal, including inside a conditional,
arithmetic or a callback's return value (comparison operands are ignored),
`refetchOnWindowFocus: false`, and a boolean or numeric `retry`. It does not
resolve identifiers, so a local numeric constant passes. `QueryClient` defaults
(`queries` and `mutations` objects) and tests are exempt. Regression tests
invoke the real Oxlint binary against accepted and rejected fixtures.

Oxlint's built-in `no-restricted-imports` keeps `CardHeader`, `CardTitle`,
`CardDescription` and `CardAction` out of `src/client/routes/admin/`, so every
settings card uses `SettingsSection` from `settings-section.tsx`, which also
owns the query loading and error states. The section shell and `StatCard` are
the only exceptions, listed in a later override; a test fails if either stops
needing it.

`query-error-handled` flags a query hook result (`useQuery`, `useInfiniteQuery`
or a `use…Query` wrapper, but not suspense queries) whose destructuring or
member reads take `isLoading`, `isPending` or `isInitialLoading` but none of
`error`, `isError`, `status`, `isLoadingError` or `isRefetchError`, so a failed
request cannot read as loading or empty
([client loading](../docs/architecture/client-loading.md)). A result passed on
whole, such as `<QueryState query={query}>`, or destructured with a rest element
is left to its consumer; reads through a local alias are followed. The rule
checks that an error field is read, not how it is rendered. It has no
exceptions.

`no-direct-web-storage` rejects `localStorage` and `sessionStorage`, read
directly or from `window`, `globalThis` or `self` (including computed keys and
destructuring), in `src/client`, `src/components` and `src/lib`; a field of that
name on other objects is allowed. Keep UI state in Web Storage with
`usePersistedState` (`src/client/hooks/use-persisted-state.ts`): it reads and
validates the stored value with Zod on the first render, writes in its stable
setter, keeps every mounted consumer of a key in agreement, keeps working in
memory when storage is blocked or full, and follows other tabs when asked.
Module-level stores use the guarded helpers in
`src/client/lib/browser-storage.ts`, the only file in its `exceptions` map; a
test fails if that exception is no longer needed. Tests may seed storage
directly.

## Remaining Biome checks

Biome remains a linter for CSS and checks without equivalent Oxlint coverage. It
no longer formats files, sorts imports or runs Grit plugins. Explicit rules that
remain are `noImplicitAnyLet`, `noAssignInExpressions`, `noBannedTypes`,
`noExcessiveCognitiveComplexity`, `useSimplifiedLogicExpression`, `noDelete`,
`useExhaustiveDependencies`, `useHookAtTopLevel`, `useConsistentArrayType`,
`noConfusingVoidType`, `useAwait`, `noFloatingPromises`, `noMisusedPromises`,
`useOptionalChain`, `noAccumulatingSpread`, `noUnusedImports`,
`noEmptyBlockStatements` and `noDangerouslySetInnerHtml`. The existing
recommended preset remains for other checks until their coverage has been
compared. Rules explicitly migrated to Oxlint are disabled in Biome. The
existing cognitive-complexity exceptions remain file-specific.

Native Oxlint equivalents for hooks, promises and some style rules have
different coverage. For example, native hook naming checks flag Storybook render
callbacks, and native array syntax differs for complex generic types. The
migration preserves existing behavior through Biome rather than introducing
application refactors or suppressions. The type-aware promise checks are enabled
after reviewing their newly detected findings. Other differences remain covered
by Biome.

Biome also preserves underscore-prefixed unused import detection, empty function
body detection and dangerous HTML checks for `React.createElement` in `.ts` and
`.js` files. Oxlint's corresponding rules do not cover all of those cases.

`scripts/check-lint-suppressions.mjs` prohibits inline Biome, Oxlint, ESLint,
Oxfmt and Prettier suppressions outside generated Prisma code. It reads actual
JavaScript/TypeScript comments so strings containing example directives remain
valid. CSS escapes and quoted strings, HTML attributes, YAML quoted and block
scalars, and Markdown code examples are handled separately. The policy also
checks HTML, YAML and Markdown in documentation and configuration directories.
Use configuration overrides for approved file-specific exceptions.

Follow [verification](../CONTRIBUTING.md#verification) before submitting
changes. Use `pnpm lint` for just the lint guardrails, `pnpm check:format` to
check formatting and `pnpm format` to apply formatting. The pre-commit hook uses
the same tools on staged source files.

## Promise ownership

Promise-returning work is awaited when its caller owns completion. Test mocks
retain their asynchronous API contracts instead of erasing them through generic
mock types. Storybook assertions are awaited as well.

Synchronous process, timer and WebSocket callbacks start explicitly detached
operations with error handling; resource-monitoring overlap protection is
preserved. Server signal cleanup reports failure and exits unsuccessfully, and
run-script cleanup falls back to its synchronous cleanup when needed.

Client event and subscription callbacks use `runInBackground` for detached work.
It catches unexpected rejection and reports a contextual error toast; repeated
failures for the same action update one toast. Explicit user-triggered rechecks
request rejection from the query API so failures reach this boundary. Existing
handlers keep their own error handling. Query refreshes remain in the background
so mutation pending state and subsequent UI actions keep their previous timing.

Staged formatter commands permit batches containing only ignored files, such as
`pnpm-lock.yaml`. Supported files still format normally, and parse errors still
block commits.
