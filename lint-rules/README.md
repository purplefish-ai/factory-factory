# Lint and formatting guardrails

[Oxlint](https://oxc.rs/docs/guide/usage/linter.html) runs the JavaScript and
TypeScript checks in `.oxlintrc.json`. Biome preserves the existing hook order,
exhaustive dependencies and promise checks. The repository already uses the
TypeScript 7 compiler via `@typescript/native` while keeping the TypeScript 6
JavaScript API for tooling.

[Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) owns formatting and
import sorting. `.oxfmtrc.json` keeps two-space indentation, single quotes,
semicolons, ES5 trailing commas and a 100-column source width. Markdown wraps
prose at 80 columns and preserves fenced code. Generated Prisma files and the
pnpm lockfile are excluded.

## Custom rules

`factory.mjs` replaces the enabled Grit rules with Oxlint's ESLint-compatible
plugin API. The rules reject awaited dynamic imports, native browser dialogs,
Next.js directives, `z.any()`/`zod.any()`, assertions on `JSON.parse` results,
and casts of promise resolvers to function types accepting `unknown`. Regression
tests invoke the real Oxlint binary against accepted and rejected fixtures.

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
application refactors or suppressions. Type-aware Oxlint checks can be evaluated
in a separate change after reviewing the newly detected findings.

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

Run `pnpm check:fix`, `pnpm typecheck`, affected tests and `pnpm check` before
submitting changes. Use `pnpm lint` for just the lint guardrails,
`pnpm check:format` to check formatting and `pnpm format` to apply formatting.
The pre-commit hook uses the same tools on staged source files.
