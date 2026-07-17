# Service Capsule Persistence Boundaries Design

## Goal

Make each backend service capsule's top-level barrel an application API rather than a persistence API. Transport, orchestration, and other capsules must express intent through public services and must not import raw accessors.

## Scope

This change covers the workspace, session, settings, terminal, decision-log, and periodic-task capsules. It removes accessor exports from their top-level barrels, migrates production consumers and affected tests, moves user-settings ownership out of workspace, routes periodic-task tRPC through the periodic-task service, and adds an automated boundary check.

It does not redesign Prisma schemas, change user-visible behavior, or move model ownership between capsules.

## Considered Approaches

### 1. Replace every accessor with an identically shaped public wrapper

This minimizes call-site edits, but merely renames the leak. A generic service exposing every persistence verb still lets consumers bypass domain behavior and conflicts with the issue's warning against one-to-one pass-through classes.

### 2. Dependency-inject every persistence need through orchestration bridges

This provides the strongest isolation, but requires rewiring many mature services and their tests at once. It is disproportionate for a boundary-hardening issue and would obscure the intended application APIs behind infrastructure plumbing.

### 3. Extend existing use-case services and add missing capsule-owned APIs

This is the selected approach. Existing public services remain the preferred surface. Missing operations are grouped by intent rather than by Prisma model, and orchestration receives only exact, documented exceptions when an operation genuinely spans models and cannot be expressed as a capsule use case.

## Public API Design

### Workspace

The workspace barrel exports its existing lifecycle, query, state, and project-management services plus focused APIs for notifications, parent/child relationships, maintenance candidate queries, PR snapshot persistence, ratchet transitions, run-script state, and initialization state. Simple reads continue through `workspaceDataService`; generic raw access such as `findRawById` is not added to the public API.

Workspace tRPC uses these services together with `sessionDataService`. Cross-service modules use intent methods appropriate to their domain, while orchestration coordinates the services without receiving a blanket accessor exemption.

Periodic-task workspace creation is added as an explicit `WorkspaceCreationSource` variant and flows through `WorkspaceCreationService`. This replaces the current direct accessor call while preserving normal creation defaults and invariants.

### Session and terminal

Agent and closed-session operations remain behind `sessionDataService`, expanded only for existing session use cases such as fixer-session acquisition and stale-session recovery. Terminal persistence moves behind a terminal-owned `terminalSessionService`; session and transport code call that API instead of importing `terminalSessionAccessor` or proxying terminal persistence through the session capsule.

Fixer acquisition resolves provider/model defaults in the session application layer, then passes the resolved values into the atomic resource operation. The session resource must not depend upward on `userSettingsService`.

### Settings

`userSettingsQueryService` moves from workspace into the settings capsule and becomes `userSettingsService`. Its public methods cover settings retrieval/update, provider defaults, workspace ordering, and the compare-and-set slash-command cache operation. Health persistence is exposed through a settings-owned health service. The cross-model backup workflow remains in orchestration; if its transaction callback cannot be represented without leaking Prisma transaction ownership, its deep accessor import is the sole exact-path, documented boundary exception.

### Decision log

The current orchestration query wrapper moves into the decision-log capsule as `decisionLogService`. It owns list/query and automatic/manual entry creation semantics. Transport code imports it from the capsule barrel.

### Periodic task

`PeriodicTaskService` gains public CRUD, toggle, and execution-history methods and remains responsible for the polling/dispatch lifecycle. `periodic-task.trpc.ts` calls this service exclusively. The raw periodic-task accessor is internal.

## Guardrail

The service-registry architecture checker will maintain an explicit map from accessor modules/bindings to owning capsules. It will reject:

- top-level capsule exports that expose a `resources/*.accessor` module;
- imports of a raw accessor binding from a capsule barrel outside the owner;
- deep imports of an accessor resource outside the owner; and
- newly discovered accessor modules that have no ownership policy.

Same-capsule resource/service implementation imports remain legal. Any exception is an exact file path with an inline policy reason; directory-wide exceptions are forbidden. Fixture tests prove allowed owner imports and each rejected leakage form.

## Data Flow and Errors

tRPC input validation and its existing `TRPCError` behavior remain unchanged. Service methods return the same Prisma-backed domain values and preserve current not-found handling at the transport layer. CAS operations, scheduling calculations, transaction boundaries, and retry behavior remain in their current owning implementations; the public services name and constrain how callers reach them.

## Testing

Implementation follows test-first cycles:

1. Add architecture-check fixtures that fail for raw barrel exports and cross-owner imports.
2. Add or update capsule export smoke tests for the new public APIs.
3. Add focused periodic-task service tests proving tRPC-facing methods delegate to persistence with current behavior.
4. Update existing consumer tests to mock public services rather than raw accessors.
5. Run focused tests after each migration group, then `pnpm typecheck`, `pnpm check:fix`, `pnpm test`, and `pnpm build`.

The repository baseline currently has 13 unrelated React failures in `setup-terminal-modal.test.tsx` and `use-setup-terminal.test.tsx` because `act` is unavailable. Verification will report these separately and require all issue-related tests to pass.

## Edge Cases

- Removing star exports can also remove public resource types; required domain record types must be re-exported intentionally from service modules without exposing accessor values.
- Type-only accessor imports leak architecture just as value imports do and are rejected.
- Tests that intentionally exercise resource implementations import their owner resource directly; consumer tests mock the public service API.
- Periodic-task update and toggle behavior must preserve schedule recalculation and enable/disable semantics.
- Workspace ownership and single-writer checks must continue to recognize the actual mutation site inside the owning capsule after call-site migration.
- The guard must not mistake unrelated classes whose names contain `Accessor` for persistence accessors; the ownership map is explicit.
