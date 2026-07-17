# Backend composition root

The backend uses one application graph to choose runtime instances and pass them to lifecycle and
transport code. This document describes the enforceable model introduced by issue #1957 and the
remaining compatibility seams that will be removed in later migrations.

## Runtime ownership

`createApplication()` in `src/backend/app-context.ts` is the production composition root. It is the
only production code that chooses the complete set of long-lived backend instances. The returned
`Application` has three sections:

- `services` contains capsule services, cross-cutting infrastructure, orchestration ports, and
  stateful factories used by transports.
- `lifecycle` contains the database disconnect port, interceptor lifecycle, domain bridge wiring,
  event collection, snapshot reconciliation, and stale-archive recovery.
- `config` is the system configuration snapshot read from the graph's configuration service.

`createDefaultApplicationDependencies()` selects the current production implementations.
Standalone and Electron entrypoints call `createApplication()` and supply that exact graph to
`createServer(application)`. The server does not construct or supplement an application graph.

The outer `Application`, `services`, and `lifecycle` containers are shallowly frozen. This prevents
consumers from replacing dependencies after composition. The service objects inside those
containers remain stateful where their public contracts require it.

`AppContext` and `createAppContext` remain aliases for compatibility. New lifecycle and transport
code should use `Application` and `createApplication` terminology.

## Constructing the graph

Production construction follows this order:

1. `createDefaultApplicationDependencies()` selects every production service and lifecycle
   participant, including factory-created event collection, snapshot reconciliation, run-script,
   and server-instance services.
2. `createApplication()` configures the supplied ACP runtime manager from the supplied config
   service.
3. It passes the complete service graph to the supplied `wireDomainBridges` function.
4. It configures the graph-owned event collector and snapshot reconciliation participants.
5. It snapshots system configuration and returns the frozen application containers.

All dependency wiring is complete before `createServer()` returns and before `ServerInstance.start()`
is called. A server start never calls a dependency `.configure()` method or chooses a default
service.

Custom composition requires a complete `ApplicationDependencies` value. There is no `Partial`
overlay and no merge with production defaults. Missing dependencies are therefore type errors
instead of silent fallback to module singletons.

## Bridge wiring

Cross-capsule relationships are represented by the `BridgeServices` portion of
`ApplicationServices`. `configureDomainBridges(services)` requires that complete set and builds
adapters only from the supplied graph. The composition root is the sole production caller.

Several capsules still expose mutable `.configure()` APIs internally. The bridge composer calls
those compatibility APIs during graph construction; server lifecycle and transports never call
them. The event collector and snapshot reconciliation objects are likewise configured during
composition and started or stopped later through graph-owned lifecycle references.

This boundary is intentional: it centralizes current mutation without pretending it has already
become constructor injection. Compatibility singleton exports also still exist for capsule-internal
and unmigrated consumers. They are selected only by the default dependency factory and must not be
imported by server or transport modules as hidden alternatives to graph dependencies.

## Server lifecycle

`createServer(application)` captures the supplied graph, constructs HTTP and WebSocket transports,
registers interceptors, and returns an idempotent lifecycle handle. Its runtime order is:

1. Bind the requested port, with bounded fallback for address conflicts.
2. Recover orphaned sessions and stale session, workspace, run-script, archive, and auto-iteration
   state using graph services.
3. Start snapshot reconciliation.
4. Clean old logs, start interceptors and periodic reconciliation, then start rate limiting,
   scheduling, ratchet processing, and periodic tasks.
5. Mark the server ready for HTTP and WebSocket traffic.

If binding or startup fails, the same cleanup path used by `stop()` runs. Cleanup clears
transport timers, stops interceptors and listeners, closes WebSocket and HTTP servers, stops session
runtimes and other graph services, stops event and snapshot reconciliation, and finally disconnects
the graph-owned database port.

Cleanup is guarded by one shared promise. Concurrent or repeated `stop()` calls therefore stop each
participant and disconnect the database at most once. A server cannot be started again after start
has begun or cleanup has begun.

## Transport boundary

Server, HTTP, tRPC, and WebSocket code resolve long-lived runtime dependencies from the supplied
`Application`:

- HTTP router and middleware factories receive the application explicitly.
- tRPC context contains the application, and procedures read runtime services from
  `ctx.appContext.services`.
- Shared tRPC helpers accept the context or a narrow service port instead of closing over a
  singleton.
- Every WebSocket upgrade-handler factory receives the exact application passed to `createServer`.
  A handler captures its graph dependencies when it is constructed.

Transport code may directly import framework utilities, schemas, types, pure functions, and
stateless constructors. It must not directly import long-lived values from backend services,
orchestration, or the database and then mix those values with injected equivalents.

Some connection registries and broadcasters remain transport-owned module state. They may keep
connection bookkeeping needed by an exported compatibility API, but their persistence, domain,
reconciliation, and logging dependencies come from the application graph. Application-scoped
registries are created per handler where concurrent graph isolation requires it.

Source-based architecture tests enforce these rules for the server, health endpoint, WebSocket
modules, and all tRPC runtime modules. The lifecycle guard also rejects composition calls in
`server.ts`; wiring belongs in `createApplication()`.

## Isolated test graphs

A composition or lifecycle test creates a complete `ApplicationDependencies` object and calls
`createApplication(dependencies)`. Test services and lifecycle participants are fakes owned by that
test. In particular:

- supply an instrumented or no-op `wireDomainBridges` function rather than mutating production
  bridge state;
- supply graph-owned event collector, snapshot reconciliation, and database lifecycle fakes;
- assert that wiring receives that graph's service object; and
- pass the returned application unchanged to server and transport factories.

Creating graph A and graph B invokes each graph's wiring function with only its own services.
Snapshot adapters captured during each composition continue to delegate to their corresponding
graph. Because custom dependencies are complete, neither graph can silently obtain a missing
production instance.

Narrow transport unit tests may use a typed fixture containing only the ports exercised by that
test. Such fixtures are not composition tests: every runtime dependency the transport actually
uses must still be supplied explicitly, and module singleton mocks must not provide hidden
fallbacks.

Lifecycle regression coverage verifies startup and idempotent shutdown of a supplied graph,
startup-failure cleanup, real server-upgrade routing, the exact graph passed to handler factories,
bridge delegation, two-graph composition isolation, and transport import boundaries.

## Remaining staged migration

The composition root is authoritative at the application boundary, but the runtime graph is not yet
a fully constructor-injected directed acyclic graph. Follow-up migrations should:

1. Replace capsule `.configure()` methods with constructor or factory dependencies.
2. Create per-graph Prisma-backed accessor factories instead of selecting module-level accessors.
3. Break cyclic session, ratchet, auto-iteration, GitHub, and workspace relationships with
   orchestration coordinators or domain events.
4. Move remaining transport compatibility broadcasters and registries behind per-application
   factories where external APIs permit it.
5. Delete compatibility singleton exports, `AppContext` aliases, and legacy configure wrappers once
   their final consumers have migrated.

Until those stages are complete, new code must not add another registry or default-merging bridge.
All new long-lived runtime dependencies belong in `ApplicationServices` or `ApplicationLifecycle`
and must be supplied by the composition root.
