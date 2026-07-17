# Root Service Registry Enforcement Design

## Goal

Make every root backend service an intentional, documented infrastructure capability or a component of a registered service capsule, and make the automated service-registry check reject unclassified root services.

## Current State

`scripts/check-service-registry.ts` derives `infraServiceFileNames` from every root TypeScript file in `src/backend/services`. A capsule import such as `@/backend/services/example.service` is therefore exempt whenever a matching root file happens to exist. The exemption is based on filename and location rather than an architectural decision.

Seven of the fourteen root services have clear domain ownership:

- `factory-config.service.ts`, `port-allocation.service.ts`, `run-script-config-persistence.service.ts`, and `run-script-proxy.service.ts` belong to run-script.
- `git-clone.service.ts`, `workspace-snapshot-store.service.ts`, and `git-ops.service.ts` belong to workspace.

The remaining seven root services are cross-cutting application infrastructure: central environment/application configuration, cryptography, logging, notifications, backend port probing, rate limiting, and server-instance state. Two root helper modules imported directly by capsules (`constants.ts` and `rate-limit-backoff.ts`) are also explicit infrastructure capabilities; the old blanket had exempted every root TypeScript file, not only services.

## Considered Approaches

### 1. Explicit infrastructure registry plus capsule moves (selected)

Declare nine infrastructure capabilities by module name, filename, and description in `src/backend/services/registry.ts`: the seven infrastructure services plus the two shared helper modules. Move the seven domain services and their tests into their owning capsules, expose them through capsule barrels, and update consumers. The checker compares actual root `*.service.ts` files with the declared infrastructure registry and uses only exact registry keys for import exemptions.

This makes additions fail closed, documents every exception next to the capsule dependency graph, and follows existing capsule/barrel conventions.

### 2. Keep domain utilities at the root and register all fourteen as infrastructure

This minimizes file movement, but it preserves the architectural problem: domain services remain globally importable capabilities and capsule dependencies through them remain absent from `dependsOn`. It does not satisfy the intent of making the graph complete.

### 3. Create dedicated git and snapshot capsules

This makes those capabilities first-class dependency nodes, but each currently serves the workspace lifecycle and has no independent persistence ownership or external domain boundary. New capsules would add registry nodes and bridge wiring without a present need.

## Architecture

`src/backend/services/registry.ts` will export `infrastructureServiceRegistry`, a typed object keyed by the exact root module name (for example, `logger.service`). Each entry contains its exact filename and a short responsibility description. The registry checker will:

1. enumerate only root production files ending in `.service.ts`;
2. reject any root service missing from `infrastructureServiceRegistry`;
3. reject any registry entry whose declared file is absent; and
4. exempt capsule imports only when their first service path segment is an exact infrastructure registry key.

Factory config access, port allocation, config persistence, and proxy logic will move under `src/backend/services/run-script/service/`. Workspace snapshot storage will move under `src/backend/services/workspace/service/snapshot/`, and repository clone and git operations under `src/backend/services/workspace/service/worktree/`. Public consumers will import these APIs from `@/backend/services/run-script` or `@/backend/services/workspace`; same-capsule consumers will use relative imports where appropriate.

## Dependency Flow

Run-script already declares a dependency on workspace. Workspace currently reads factory config and calls run-script config persistence when refreshing cached commands, which would create a workspace-to-run-script import and a registry cycle after the move. Those configuration query operations will move from `WorkspaceQueryService` to the run-script config persistence service. The workspace tRPC endpoints will call the run-script barrel, and run-script will use workspace accessors through its existing declared dependency. The capsule graph stays acyclic and accurately records `run-script -> workspace`.

The workspace snapshot store and git operations are workspace-owned APIs. Moving them into the workspace capsule does not introduce new cross-capsule dependencies. The `src/backend/lib/session-summaries.ts` type import will point directly at the shared session runtime contract so that the low-level lib layer does not depend on the workspace barrel.

## Error Handling and Compatibility

Runtime behavior and public API shapes remain unchanged. File moves preserve the existing classes, singletons, and method behavior. Existing error handling remains in the services. The new checker errors identify either the unclassified root filename or the stale infrastructure registry entry and tell maintainers to move the service into a capsule or register it intentionally.

Mocks and tests will follow the new barrel paths. Dependency Cruiser remains the secondary enforcement layer for barrel-only cross-service imports and cycles.

## Testing

- Add an integration-style checker regression test that creates a temporary root `*.service.ts`, runs `check:service-registry`, asserts failure with the classification message, and always removes the file.
- Extend run-script and workspace barrel smoke tests to cover the moved public services.
- Move existing unit tests with their implementations and update mocks/import paths.
- Move workspace-query configuration tests to the run-script config persistence suite and keep the tRPC behavior unchanged.
- Run focused Vitest tests, `pnpm check:service-registry`, and `pnpm deps:check` during implementation.
- Run the required final sequence: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.

## Edge Cases

- Root tests and helper files that do not end in `.service.ts` are not infrastructure services and must not require classification.
- A stale registry entry must fail even if nothing imports it.
- A similarly prefixed module name must not match an infrastructure capability; matching is exact.
- Moving services must not allow external consumers to deep-import capsule internals.
- Factory-config query endpoints must keep their existing response and error behavior after ownership moves to run-script.
- Temporary checker-test files must be removed in `finally` cleanup so interrupted assertions do not dirty the worktree.
