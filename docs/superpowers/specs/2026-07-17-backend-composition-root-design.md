# Backend Composition Root Design

## Problem

The backend currently has three competing dependency models. `AppContext` contains a partial service bag, `domain-bridges.orchestrator.ts` has a larger private service registry with singleton fallbacks, and `server.ts` imports additional lifecycle instances directly. tRPC and WebSocket transports receive `AppContext` but still import long-lived singleton equivalents. As a result, startup order performs dependency wiring, partial test overrides silently retain global instances, and two application graphs cannot be reasoned about independently.

## Goals

- Make one application type and factory the authoritative registry for backend runtime instances.
- Complete dependency wiring before `createServer(...).start()` is called.
- Require HTTP, tRPC, and WebSocket transports to resolve long-lived runtime dependencies from the supplied application graph.
- Allow tests to supply a complete dependency set and construct a graph without mutating production singleton state.
- Preserve existing startup, shutdown, upgrade routing, and bridge behavior while making lifecycle ownership explicit.
- Document the dependency and lifecycle model and add executable architecture guards.

## Non-goals

- Rebuild all capsule-internal accessors around an injected Prisma client in this change.
- Eliminate every exported singleton implementation in one pull request.
- Replace the service-capsule import registry; it remains the source of allowed static imports and Prisma model ownership, while the composition root describes runtime instances.
- Change user-visible HTTP, tRPC, WebSocket, or UI behavior.

## Options considered

### Widen the existing partial service bag

The smallest option is to add server dependencies to `AppServices` and move the three configure calls from `server.start()` to `createAppContext()`. This removes visible startup ordering but preserves partial override merging and private singleton fallbacks. It does not provide an isolated test graph, so it is insufficient.

### Authoritative staged composition root

The selected option keeps current production implementations where necessary but makes `app-context.ts` the only place that chooses them. The root accepts a complete dependency object for custom graphs, wires only the supplied instances, freezes the graph containers, and returns the application consumed by server and transports. Legacy `.configure()` methods may remain behind this boundary temporarily, but no consumer or lifecycle entrypoint calls them and no wiring function silently chooses a default.

This option satisfies the runtime boundary without forcing all 68 singleton/store/accessor construction sites and several circular domain relationships into one risky rewrite.

### Full constructor-injected DAG

The long-term endpoint would inject Prisma into every accessor, export factories for every stateful service, and replace session/ratchet/auto-iteration and GitHub/workspace cycles with application coordinators and events. That is cleaner, but it changes many capsule internals and their tests simultaneously. The staged root deliberately exposes seams for that migration later.

## Application model

`src/backend/app-context.ts` remains the composition module for compatibility, but its public model changes from a partial context overlay to an application graph:

```ts
export interface Application {
  readonly services: Readonly<ApplicationServices>;
  readonly lifecycle: Readonly<ApplicationLifecycle>;
  readonly config: AppConfig;
}

export interface ApplicationDependencies {
  readonly services: ApplicationServices;
  readonly lifecycle: ApplicationLifecycle;
}

export function createApplication(dependencies?: ApplicationDependencies): Application;
```

`ApplicationServices` is the union of the public service instances needed by domain bridges, lifecycle reconciliation, tRPC procedures, health routing, and WebSocket handlers. Capsule-internal collaborators that never cross a public capsule boundary can remain encapsulated by their public service during this stage.

`ApplicationLifecycle` owns process-level infrastructure and orchestration that was previously imported by `server.ts`: the database disconnect port, interceptor lifecycle, domain wiring function, event collector instance, snapshot reconciliation instance, reconciliation service, stale-archive recovery, and other startup/shutdown participants.

`createApplication()` without arguments builds the production dependency set. Passing dependencies requires the complete `ApplicationDependencies` type; there is no `Partial` merge. This makes missing test dependencies a type error instead of silently selecting production globals. The returned `services`, `lifecycle`, and outer graph containers are frozen; contained stateful services remain internally mutable by design.

For compatibility during migration, `AppContext` may remain a type alias for `Application`, and `createAppContext` may remain a deprecated alias. Production entrypoints use `createApplication`.

## Wiring and lifecycle

The composition factory performs dependency wiring once:

1. Apply configuration to the supplied ACP runtime manager from the supplied config service.
2. Create a session service only when production defaults require a runtime/domain pairing; custom graphs supply their full service set.
3. Invoke the supplied domain-wiring function with a complete bridge dependency type. `configureDomainBridges` no longer accepts `Partial` values or merges private defaults, and `periodicTaskService` becomes an explicit bridge dependency.
4. Configure the graph-owned event collector and snapshot reconciliation instances without starting server lifecycle work.
5. Return the immutable graph containers.

`createServer` requires an application graph and never constructs one. `start()` binds the server, performs recovery, and starts already-wired lifecycle services. `stop()` stops only instances obtained from the graph and disconnects the graph-owned database port. The server no longer imports Prisma, service singletons, accessors, reconciliation singletons, or configure wrappers.

Startup failure uses the existing idempotent cleanup path. Dependency construction or wiring failure occurs before a server exists and therefore cannot leave a partially started server. Existing start/stop guards remain unchanged.

## Transport dependency rule

Runtime transport modules may import schemas, types, pure helpers, router constructors, and framework utilities. They must not import long-lived instances from `@/backend/services`, `@/backend/orchestration`, or `@/backend/db`.

- tRPC procedures read services through `ctx.appContext.services`.
- HTTP router factories read services through the supplied application.
- WebSocket handler factories capture dependencies from the supplied application once at construction.
- Helpers used by tRPC procedures receive `Context` or a narrow dependency argument instead of closing over a singleton.

Transport-owned connection registries and broadcasters may remain module-local in this stage when they are not equivalents of application/domain services. Their domain, persistence, reconciliation, and logging dependencies must still come from the graph. A source-based architecture test enforces the import rule across server, tRPC, health, and WebSocket production files.

## Test isolation

Tests that exercise composition create a complete fake `ApplicationDependencies` object. The fake wiring function and lifecycle objects record which service graph they received. Constructing graph A and graph B must show that each wiring call receives only its own services and that neither construction calls production singleton wiring.

Transport unit tests may continue using narrow coerced application fixtures, but every runtime dependency used by the transport must be present in the fixture rather than supplied by a mocked module singleton. Server lifecycle tests supply lifecycle fakes through the application and stop mocking global orchestration/database modules.

## Testing strategy

- Composition-root tests cover complete dependency use, immutable containers, ACP configuration from the supplied config service, and two-graph isolation.
- Domain-bridge tests pass an explicit complete service set and continue verifying adapter delegation.
- Server lifecycle tests prove `start()` performs no dependency configuration, startup recovery uses graph instances, cleanup uses graph instances exactly once, and upgrade routing still uses the shared graph.
- WebSocket integration tests continue exercising real upgrades and provide graph dependencies for terminal, snapshot, and chat paths.
- Transport architecture tests reject direct long-lived imports and module-scope application construction.
- Existing tRPC router tests verify that supplied context dependencies are used.

## Edge cases

- A second `start()` call remains rejected without rerunning cleanup.
- `stop()` remains idempotent before start, after successful start, and after startup failure.
- Startup recovery failures are logged and do not prevent readiness, matching current behavior.
- A bind failure cleans up only the supplied graph.
- Two composed test graphs do not overwrite one another's bridge targets.
- A missing custom dependency fails at compile time; custom graphs never fall back to a production singleton.
- Electron and standalone entrypoints both construct the same application root and register the resulting server instance in that graph.

## Durable architecture documentation

`docs/design/backend-composition-root.md` will describe the final runtime ownership rules, graph sections, construction/start/stop sequence, test construction pattern, permitted transport imports, and the staged path from compatibility singleton implementations to per-graph factories.

## Success criteria

- One exported application type/factory represents every public runtime dependency used by bridges, lifecycle, and transports.
- No `.configure()` call occurs in `server.start()`.
- Server, tRPC, health, and WebSocket code do not mix graph dependencies with hidden long-lived singleton imports.
- A test can construct two complete graphs using fakes without touching production global wiring.
- Startup, shutdown, upgrade routing, and bridge delegation remain covered and passing.
- The durable architecture document and source guard make the new dependency model explicit and enforceable.
