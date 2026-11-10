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
accepting `unknown`, type assertions on agent-supplied data under
`src/client/features/chat` (tool input such as `input.todos as …` or
`call.input.file_path as …`, which renderers parse with `parseToolInput` and a
Zod schema, and stream payloads such as `event.delta as …` or
`event.content_block as …`, which the reducer path parses with Zod and skips
when they do not match), and fixed Tailwind palette color classes (`bg-red-500`,
`dark:text-emerald-300`) in `src/client`, `src/components` and `src/lib`, which
must use theme tokens instead ([status colors](../docs/status-colors.md)). The
palette rule's file exceptions are its `exceptions` option, a map from path to
reason in `.oxlintrc.json`; a test fails if an exception no longer needs it.
`use-pending-prop` rejects a `Spinner`, `SpinnerGapIcon` or `animate-spin`
element inside `Button` or `DropdownMenuItem`, which take `pending` instead, and
`no-raw-spinner` rejects a bare `SpinnerGapIcon` and `animate-spin` outside the
shared `Spinner`
([pending controls](../docs/architecture/client-loading.md#pending-controls)).
`no-raw-tab-role` rejects a `role="tab"` or `role="tablist"` attribute (or
`role` prop) outside the shared `TabList` and `TabButton` in
`src/components/ui/tab-button.tsx`, so every tab bar shares one look and
keyboard behavior ([keyboard shortcuts](../docs/keyboard-shortcuts.md)); tests
are exempt. Each takes its own `exceptions` map in the same shape; their test
lints each listed file with the rule and no exceptions and fails once a file
stops reporting. `query-owner` keeps tRPC hooks and cache helpers for named
procedures inside owner modules. Each entry in its `groups` option lists
procedures, the module callers should `use`, its `owners` (that module and its
helpers), the reason, and which helpers it covers: `cache` covers helpers that
install options or write data (`useQuery`, `fetch`, `setData` and similar) plus
`getQueryKey`, and `all` covers every hook, cache helper and key helper,
including `useMutation`. `workspace.get` and `workspace.listForProject` use
`cache`, so every read installs the snapshot reconciler
([workspace state](../docs/architecture/workspace-state.md)). `userSettings.get`
and `userSettings.update` use `all`: settings are read and written only through
`useUserSettings` and `useUpdateUserSettings` in
`src/client/lib/user-settings-queries.ts`, which own the optimistic cache
strategy and error toast. `userSettings.getProviderOptions` uses `cache` and is
read through `useProviderOptions` in the same module, so every reader of the
live model catalog shares one stale time. Tests are exempt so they can seed
caches. `named-query-options` keeps query options in one place
([query retries and polling](../docs/architecture/client-loading.md#query-retries-and-polling)):
it rejects a numeric `refetchInterval` literal, including inside a conditional,
arithmetic or a callback's return value (comparison operands are ignored),
`refetchOnWindowFocus: false`, and a boolean or numeric `retry`. It does not
resolve identifiers, so a local numeric constant passes. `QueryClient` defaults
(`queries` and `mutations` objects) and tests are exempt. Regression tests
invoke the real Oxlint binary against accepted and rejected fixtures.

`no-arbitrary-font-size` rejects arbitrary font sizes such as `text-[10px]` or
`md:text-[0.8rem]`; use the type scale's `text-2xs`, `text-xs` and up instead.
`use-status-callout` rejects a class string pairing a tinted status background
(`bg-destructive/5`) with a border of the same status token
(`border-destructive/30`); render that surface with `StatusCallout` or
`StatusChip` instead. Hover, focus and data-state tints pass
([callouts and chips](../docs/status-colors.md#callouts-and-chips)). Both take
an `exceptions` map with the same stale-exception test and skip tests.

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
directly or from `window`, `globalThis` or `self` (including static computed
keys and destructuring; a dynamic `window[key]` is not detected), in
`src/client`, `src/components` and `src/lib`; a field of that name on other
objects is allowed. Keep UI state in Web Storage with `usePersistedState`
(`src/client/hooks/use-persisted-state.ts`): it reads and validates the stored
value with Zod on the first render, writes in its stable setter, keeps every
mounted consumer of a key in agreement, keeps working in memory when storage is
blocked or full, and follows other tabs when asked. Module-level stores use the
guarded helpers in `src/client/lib/browser-storage.ts`, the only file in its
`exceptions` map; a test fails if that exception is no longer needed. Tests may
seed storage directly.

`no-forward-ref` rejects `forwardRef` outside `src/components/ui/`: React 19
passes `ref` as a prop. `no-render-ref-write` rejects assigning or incrementing
`ref.current` directly in a component or hook body (a function named `use…` or
starting with a capital, including one passed to `memo` or `forwardRef`), except
lazy initialisation (`if (ref.current === null)`, `!ref.current`, `??=`).
`no-state-sync-effect` rejects a `useEffect` or `useLayoutEffect` with
dependencies whose body only calls `set…` functions, possibly behind `if`s, with
values that contain no call, `.current` read, `await` or `new`. Both apply to
`src/client`, `src/components` and `src/hooks` outside tests, with
`no-state-sync-effect` also off in stories; their `exceptions` maps work like
the spinner rules' ([client state](../docs/architecture/client-state.md)).

Button sizing follows the `size` variant
([buttons and tooltips](../docs/shadcn.md#buttons-icon-buttons-and-tooltips)).
`button-icon-size` rejects `h-*`/`w-*` classes on an icon (`*Icon`, `svg`)
anywhere inside a `Button` or `IconButton`, through conditionals, fragments and
wrappers; the variant sizes icons and a `size-*` class is the explicit opt-out.
It also rejects a positive horizontal margin (`mr-2`, `md:ml-1.5`, `me-1`) on an
icon that is a direct flex item of the control (through conditionals, fragments
and an `asChild` child), because the variant's `gap` already spaces icon and
label; negative optical offsets, `ml-auto` and icons inside a wrapper element
pass. `button-size-variant` rejects a fixed `h-N`, `w-N` or `size-N` (with any
variant prefix) in a `Button` or `IconButton` `className`; keywords such as
`w-full` and `h-auto`, arbitrary values and `min-`/`max-` widths are layout and
pass. `icon-button-tooltip` rejects an icon-size `Button` rendered by
`TooltipTrigger asChild` (also through nested `…Trigger asChild` elements) or
carrying a native `title`; use `IconButton`. `tooltip-provider-root` rejects
`<TooltipProvider>` outside the root providers, and `focus-ring` (`src/client`
only) rejects the hand-rolled `focus-visible:ring-2` and
`focus-visible:outline…` styles that the `focus-ring` utility replaces. Each
takes an `exceptions` map, checked by the same still-needed test as the pending
rules; tests are exempt from `tooltip-provider-root` so they can supply their
own provider.

## Remaining Biome checks

Biome remains a linter for CSS and checks without equivalent Oxlint coverage. It
no longer formats files, sorts imports or runs Grit plugins.
`useExhaustiveDependencies` treats the results of `useLatestRef` and
`useStableCallback` as stable, like `useRef`, so they stay out of dependency
arrays. Explicit rules that remain are `noImplicitAnyLet`,
`noAssignInExpressions`, `noBannedTypes`, `noExcessiveCognitiveComplexity`,
`useSimplifiedLogicExpression`, `noDelete`, `useExhaustiveDependencies`,
`useHookAtTopLevel`, `useConsistentArrayType`, `noConfusingVoidType`,
`useAwait`, `noFloatingPromises`, `noMisusedPromises`, `useOptionalChain`,
`noAccumulatingSpread`, `noUnusedImports`, `noEmptyBlockStatements` and
`noDangerouslySetInnerHtml`. The existing recommended preset remains for other
checks until their coverage has been compared. Rules explicitly migrated to
Oxlint are disabled in Biome. The existing cognitive-complexity exceptions
remain file-specific.

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
It catches unexpected rejection and reports a contextual error toast, by default
"Couldn't refresh data." for cache refreshes; repeated failures for the same
action update one toast. Explicit user-triggered rechecks request rejection from
the query API so failures reach this boundary. Existing handlers keep their own
error handling. Query refreshes remain in the background so mutation pending
state and subsequent UI actions keep their previous timing.

Staged formatter commands permit batches containing only ignored files, such as
`pnpm-lock.yaml`. Supported files still format normally, and parse errors still
block commits.
