# Session providers module

The caches in front of the provider model catalogs and plan usage. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. This guide covers the model catalogs. Bare
file names below are in this directory; paths that start with `src/` are from
the repository root.

## Owns, and does not own

The module owns when a model catalog is discovered again, sharing one discovery
among callers, keeping the last good catalog, a separate Codex catalog per
account, and stopping discovery at shutdown. It does not own:

- Discovery itself, in disposable provider processes:
  `fetchClaudeModelCatalogFromAcp` and `fetchCodexModelCatalogFromAppServer` in
  `../acp/`. They report when a child has drained through the `retainLifetime`
  callback they are given.
- Who reads the catalogs: the configuration projection (`../config/`), the
  provider options in `src/backend/trpc/user-settings.trpc.ts`, and the warm-up
  after startup in `src/backend/server.ts`.
- When shutdown stops the caches, and what waits for them:
  `src/backend/application-shutdown.ts`.

## Public surface

The capsule barrel exports the singletons `claudeModelCatalogService`,
`codexModelCatalogService` and `providerUsageService`, built in
`../composition/session-core-services.ts` with the `../acp/` loaders as
`fetchModels`, and the class `CodexModelCatalogService`. `getModels()` (with a
Codex account ID, or none for Auto) returns a catalog; `stop()` ends discovery
for good.

## Invariants

- A cache runs one discovery at a time and shares it with every concurrent
  caller, including its failure; the next request after a failure starts a new
  discovery unless the failed one's child is still draining (below).
  `claude-model-catalog.service.test.ts`, `codex-model-catalog.service.test.ts`,
  `../config/session-config-projection.test.ts`.
- Once a catalog is five minutes old, a read returns it at once and starts one
  background refresh unless a child is still draining; a failed refresh keeps
  it, logs one warning without the error, and is not retried for 30 seconds.
  `model-catalog-cache.test.ts`, `codex-model-catalog.service.test.ts`.
- Every read returns its own copy of the catalog.
  `codex-model-catalog.service.test.ts`.
- After a discovery settles, the cache starts no other discovery until its child
  has drained: reads without a catalog fail as busy, and a stale catalog is
  served without a refresh. `model-catalog-cache.test.ts`.
- `stop()` aborts the running discovery and refuses every later one, then waits
  at most seven seconds for children to drain. `model-catalog-cache.test.ts`,
  `codex-model-catalog.service.test.ts`.
- Codex catalogs are cached per account; Auto merges the catalogs of the enabled
  accounts and fails only when none is available.
  `codex-model-catalog.service.test.ts`.

## Map

- `model-catalog-cache.ts`: `ModelCatalogCache`, the freshness, sharing,
  drain-admission and shutdown rules above.
- `claude-model-catalog.service.ts`: the Claude cache, a `ModelCatalogCache`.
- `codex-model-catalog.service.ts`: one cache per Codex account and the Auto
  merge.
- `provider-usage.service.ts`: plan usage. Claude's reading is shared and cached
  for 30 seconds; Codex usage comes from the account service.
