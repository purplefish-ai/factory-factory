# Oxc migration evaluation

The migration keeps existing checks where the native Oxlint equivalent has
different semantics. Biome remains for those rules and its recommended checks;
there are no new inline suppressions or application behavior changes.

The source conversion includes small equivalent style corrections, including an
initialized constant captured by a promise callback, template strings and
braces. The native `prefer-const` rule permits reads in callbacks declared
before the later assignment, preserving the repository's initialization
patterns.

## Timing preview

Single local runs on October 8, 2026, with Node 26.8.1, Oxlint 1.87.0 and Oxfmt
0.72.0 produced the following wall-clock times. These are indicative
measurements on the same source tree, not a statistical benchmark.

| Check                           | Before |  After |
| ------------------------------- | -----: | -----: |
| Original `biome check .`        | 4.02 s |      — |
| Oxlint native and project rules |      — | 0.40 s |
| Residual `biome lint .`         |      — | 1.98 s |
| Oxfmt format check              |      — | 0.26 s |
| Inline suppression policy       | 0.12 s | 0.41 s |
| Total of these layers           | 4.14 s | 3.05 s |

The preview checked about 1,407 source files. Oxfmt also checked Markdown, YAML
and other supported files, bringing its total to 1,886. Before conversion it
reported formatting or import-sorting changes in 1,069 files. These timing runs
did not apply changes. The final configuration preserves adjacent import groups
(`newlinesBetween: false`), reducing conversion to about 180 changed tracked
files while keeping every existing file-length ceiling. The broader repository
checks, including ownership, dependencies, schemas and type checking, remain
separate.

## Checks evaluated but retained in Biome

The initial Oxlint preview enabled native equivalents with their default
options. The following findings reflect differences in detection and do not
establish that each reported case is a bug.

| Native Oxlint rule               | Findings | Reason to preserve existing Biome rule                         |
| -------------------------------- | -------: | -------------------------------------------------------------- |
| `no-floating-promises`           |       53 | TypeScript inference detects more promise-like expressions.    |
| `no-misused-promises`            |       55 | Void callback contracts and framework handling require review. |
| `require-await`                  |      353 | Includes async test mocks and callbacks that Biome accepts.    |
| `no-invalid-void-type`           |       44 | Different treatment of void unions and generic arguments.      |
| `array-type` with `array-simple` |       68 | Different complex generic and tuple array syntax.              |
| `rules-of-hooks`                 |       13 | Names of anonymous Storybook render callbacks.                 |
| `exhaustive-deps`                |       18 | Additional object dependency and cleanup ref checks.           |
| `prefer-optional-chain`          |       10 | Requires type-aware analysis and separate coverage review.     |
| `no-accumulating-spread`         |        1 | Native rule also covers loop accumulation.                     |

Examples worth reviewing before enabling stronger promise checks:

- The native floating-promise rule flags `interceptor.stop!()` in
  [the branch naming interceptor test](../src/backend/interceptors/branch-naming.interceptor.test.ts)
  because its type is `void | Promise<void>`. The test's intended
  synchronization needs to be verified before deciding whether to await it.
- The native misused-promise rule flags
  `child.on('error', async (error) => ...)` in
  [the ACP runtime error handler](../src/backend/services/session/service/acp/acp-runtime-error-handler.ts).
  The callback consumer's error and completion handling must be examined before
  replacing the callback with a void wrapper.
- The native exhaustive-dependency rule flags dependencies on the whole `chat`
  object in
  [the chat websocket hook](../src/client/features/chat/use-chat-websocket.ts).
  Updating those arrays without reviewing object identity could change callback
  stability and websocket behavior.

Those rules remain enforced by the existing Biome configuration in this change.
The native preview's broad correctness category also enabled unrelated rules,
including React Compiler checks and `unbound-method`. The committed Oxlint
configuration uses explicit migrated rules while Biome preserves its existing
recommended preset, avoiding an unrelated expansion of lint policy.
