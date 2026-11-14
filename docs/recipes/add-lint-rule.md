# Add a lint rule

## Use when

You add a `factory/<rule-name>` Oxlint rule that rejects a pattern in the code.
`<rule-name>` is its kebab-case name (`no-direct-web-storage`); `<ruleName>` is
the same in camel case. Read [lint guardrails](../../lint-rules/README.md)
first: it says what each rule file holds and how exceptions work.

## Steps

1. List what the rule would report today with `rg`. Fix those files in their own
   pull request first, or list each in the exceptions file (step 5).
2. Create `lint-rules/rules/<rule-name>.mjs`: a default export with
   `meta.docs.description`, and `create(context)` returning AST visitors that
   call `context.report({ node, message })`; the message names the fix.
   `lint-rules/rules/no-await-import.mjs` is the smallest model.
3. Register it in `lint-rules/factory.mjs`: add
   `import <ruleName> from './rules/<rule-name>.mjs';` and the entry
   `'<rule-name>': <ruleName>,` in `rules`, both in alphabetical order.
4. Create `lint-rules/rules/<rule-name>.test.ts` calling `describeRuleFixtures`
   from `../testing/rule-fixtures` with `rejected` and `accepted` sources
   (`lint-rules/rules/no-await-import.test.ts`). It passes when each rejected
   source reports exactly one error, from this rule, and each accepted none:

   ```sh
   pnpm test lint-rules/rules/<rule-name>.test.ts
   ```

5. Only if files are excepted: add `schema: EXCEPTIONS_SCHEMA` to `meta`, create
   `lint-rules/rules/<rule-name>.exceptions.json` (repository path to reason),
   and return `{}` from `create` when `isExceptedFile(context, exceptions)` is
   true (`lint-rules/rules/no-raw-spinner.mjs` shows all three). Then
   `pnpm test lint-rules/exceptions.test.ts` passes.
6. Enable it in `.oxlintrc.json` with `"factory/<rule-name>": "error"`: in the
   top-level `rules` for every file, or in the `overrides` entry whose `files`
   match its scope (add one if none does). Turn it `"off"` in the `**/*.test.ts`
   override if tests are exempt.
7. Prove the repository enables it: write the pattern into a scratch file in the
   rule's scope (the command uses one under `src/lib/`; move it if the rule is
   scoped elsewhere), lint it and see `error factory(<rule-name>)`, then delete
   the file.

   ```sh
   pnpm exec oxlint --deny-warnings src/lib/rule-scratch.ts; rm src/lib/rule-scratch.ts
   ```

8. Run `pnpm check:fix` (it also sorts the import from step 3), `pnpm typecheck`
   and `pnpm check`; all pass. If the rule enforces a guide, link the guide from
   the rule's header comment; edit `lint-rules/README.md` only when the way
   rules are written changes.

## Mistakes this prevents

- A rule left out of `factory.mjs`: `pnpm check` fails in Knip with the rule
  under "Unused files", and its fixture test fails with a `SyntaxError`, because
  Oxlint printed `Rule '<rule-name>' not found in plugin 'factory'`, not JSON.
- A rule enabled in `.oxlintrc.json` under a name `factory.mjs` does not have:
  every lint run fails with that same message.
- A rule registered but never enabled: every check passes and the rule reports
  nothing; step 7 catches it.
- Enabling a rule before the code complies: `pnpm lint` fails on each file that
  already has the pattern.
- An exception whose reason is 20 characters or fewer, or one whose file no
  longer reports: `lint-rules/exceptions.test.ts` fails.
- Deleting the exceptions file but not its import: every lint run crashes.
- An inline `oxlint-disable` comment instead of an exception: `pnpm lint` fails
  in `check-lint-suppressions` with `Found 1 inline lint/format suppressions`.
