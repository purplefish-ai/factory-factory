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

`factory.mjs` is the `factory` plugin, which replaces the enabled Grit rules
with Oxlint's ESLint-compatible plugin API. That API remains alpha: keep exact
tool pins and real-binary fixtures when upgrading it.

Each rule has its own files in `rules/`:

- `<rule-name>.mjs` exports the rule. Its `meta.docs.description` says what it
  rejects; where the rule has a rationale beyond that or enforces a guide, a
  header comment gives the rationale and links the guide.
- `<rule-name>.test.ts` lists rejected and accepted fixtures for
  `describeRuleFixtures` (`testing/rule-fixtures.ts`), which lints each one as
  its own module with the real Oxlint binary and every factory rule enabled. A
  rejected fixture must report exactly one error, from its rule; an accepted
  fixture must report nothing. A fixture may name its path, and `files` enables
  the rule only for matching paths, as an override does. Checks of the rule's
  scoping in `.oxlintrc.json` sit beside them. A rule that reads the file system
  (`fileSystemRules` in the helper) is enabled only for its own fixtures, since
  other rules' fixtures mock modules that do not exist.
- `<rule-name>.exceptions.json`, only when files are excepted from the rule.

Helpers used by several rules are plain modules in `lib/`; a helper used by one
rule stays in that rule's file. `factory.mjs` imports every rule statically, in
alphabetical order, and exports the plugin object. `.oxlintrc.json` enables each
rule, sets its severity, scopes it to directories through `overrides` and turns
it off for tests or stories where they are exempt; `query-owner` also takes its
procedure groups there. `pnpm test` runs the rule tests, `pnpm typecheck` checks
them, and Knip reports a rule file that `factory.mjs` does not import.

### Exceptions

A rule that takes an `exceptions` option (`EXCEPTIONS_SCHEMA` in
`lib/exceptions.mjs`) reads its default from `rules/<rule-name>.exceptions.json`
when that file exists: a map from a repository-relative path to the reason that
file may keep the reported pattern. A rule without the file has no default
exceptions. An `exceptions` option in an Oxlint configuration replaces the
default; the project configuration does not set one. Keep the lists short and
give every entry a reason.

`exceptions.test.ts` covers every rule that takes the option and every
exceptions file. Each reason must be longer than 20 characters, each file must
belong to a rule that takes the option, and each listed path is linted with its
rule and `exceptions: {}`: the test fails once a path no longer reports, so a
stale exception is removed rather than kept. The Oxc editor extension's language
server loads the same plugin, exceptions included; restart it after editing a
rule or an exceptions file.

### Adding a rule

1. Create `rules/<rule-name>.mjs` with `meta.docs.description`, a header comment
   for any rationale and guide links, and `schema: EXCEPTIONS_SCHEMA` if files
   may be excepted.
2. Create `rules/<rule-name>.test.ts` calling `describeRuleFixtures` with
   rejected and accepted sources.
3. If files are excepted, create `rules/<rule-name>.exceptions.json` and import
   it in the rule with `with { type: 'json' }` as the default for
   `isExceptedFile`.
4. Add the rule's import and its entry to `factory.mjs`, alphabetically.
5. Enable it with one `"factory/<rule-name>": "error"` line in `.oxlintrc.json`,
   in the override that scopes it (add one if none matches), and add it to the
   test override if tests are exempt.

### Built-in rule options

Oxlint's built-in `no-restricted-imports` keeps `CardHeader`, `CardTitle`,
`CardDescription` and `CardAction` out of `src/client/routes/admin/`, so every
settings card uses `SettingsSection` from `settings-section.tsx`, which also
owns the query loading and error states. The section shell and `StatCard` are
the only exceptions, listed in a later override; `no-restricted-imports.test.ts`
fails if either stops needing it.

The same rule keeps route code from calling `useChatWebSocket`, through the
barrel or its module: a route renders the chat inside `ChatSessionProvider`, so
streamed events re-render the chat and not the layout
([client state](../docs/architecture/client-state.md)). Type imports stay
allowed. The admin override repeats the entry, because an override replaces the
rule's options rather than merging them.

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
