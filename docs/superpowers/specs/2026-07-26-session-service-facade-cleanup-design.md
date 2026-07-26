# Session Service Facade Cleanup Design

## Goal

Replace `SessionService`'s forwarding API with direct access to the session capsule's focused services. Keep `SessionService` only as the coordinator for serialized ACP prompt execution and content conversion.

## Current Problem

`SessionService` constructs the session repository, prompt builder, lifecycle, configuration, permission, retry, prompt-turn-completion, and ACP event-processing services. Most of its public methods simply delegate to one of those dependencies. Callers therefore depend on a broad facade even when they use only one capability, while wrapper-only tests preserve delegation code that has no business behavior.

## Public API

The session barrel will export the shared instances callers need:

- `sessionLifecycleService`
- `sessionConfigService`
- `sessionPermissionService`
- `sessionRetryService`
- `sessionPromptTurnCompletionService`
- `acpEventProcessor`
- `sessionRepository`
- `sessionPromptBuilder`
- `sessionService`

`sessionService` keeps its existing name but exposes only prompt-coordination operations:

- `sendSessionMessage`
- `sendAcpMessage`

Prompt queue cleanup remains an implementation-level collaboration between the lifecycle and prompt services rather than a general caller API.

There will be no deprecated forwarding methods or compatibility aliases. TypeScript errors will identify every caller that still uses the old facade.

## Service Ownership

Callers will use the service that owns each operation:

| Capability | Owner |
| --- | --- |
| Start, stop, restart, client lookup, session options, stop generations, runtime snapshots, and shutdown | `sessionLifecycleService` |
| Model, reasoning effort, thinking budget, ACP config options, and chat capabilities | `sessionConfigService` |
| ACP permission responses | `sessionPermissionService` |
| Runtime running/working checks and prompt cancellation | `acpRuntimeManager` |
| Prompt-turn-completion handler registration | `sessionPromptTurnCompletionService` |
| Stale persisted-session recovery | `sessionRepository` |
| Serialized prompt sending, prompt activity state, and content-block conversion | `sessionService` |

Transcript-to-history conversion will move to the interceptor boundary, where that external history shape is consumed. It will read transcript state directly from `sessionDomainService`.

## Construction and Wiring

A session-capsule composition module will construct the shared instances once and export them through the session barrel. `SessionService` will receive its collaborators instead of constructing the service graph.

`SessionLifecycleService` will receive the prompt sender during construction so its public `startSession` and `restartSession` signatures remain convenient: callers pass only the session ID and options. Lifecycle stop and exit hooks will clear serialized prompt queues through the prompt coordinator. The wiring may use closures to connect these two services, but neither service will construct the other.

The orchestration layer will configure each bridge-owning service directly:

- `sessionLifecycleService.configure(...)` receives lifecycle bridges.
- `sessionService.configure(...)` receives the workspace-activity bridge needed while a prompt is running.
- `sessionPromptTurnCompletionService.setHandler(...)` receives the completion callback.

The application context will expose focused services where dependency injection is needed. External session consumers will import only from `@/backend/services/session`; session-capsule implementation files may use internal relative imports.

## Behavior Preservation

The refactor will preserve:

- Per-session ACP prompt serialization and queued-prompt rejection during stop or exit.
- Content conversion for text, thinking, image, and tool-result blocks.
- Prompt runtime-state transitions, workspace activity generation checks, orphaned tool-call finalization, and completion scheduling.
- Lifecycle start, stop, restart, and shutdown behavior.
- Existing configuration, permission, retry, repository, and prompt-building behavior.

Removing the facade also removes its accidental duplicate call to `setSessionModel`; direct callers will invoke the configuration service once.

## Testing

The wrapper-only `session.service.coverage.test.ts` will be removed because it asserts delegation rather than behavior.

Behavioral tests will follow ownership:

- Prompt serialization, queue clearing, prompt execution state, and content conversion remain covered by `SessionService` tests.
- Lifecycle behavior is exercised through `SessionLifecycleService`.
- Configuration, permission, retry, repository, prompt-builder, and ACP event-processing tests continue to target those services directly.
- Orchestration, WebSocket, tRPC, server lifecycle, and application-context tests will use the focused service dependencies and verify their existing observable behavior.

Validation will include the relevant Vitest tests, full `pnpm test`, `pnpm typecheck`, `pnpm check`, and formatting with `pnpm check:fix`.

## Non-Goals

- Renaming `SessionService` or changing user-visible session behavior.
- Adding a replacement `sessionServices` registry or service locator.
- Keeping a transitional compatibility layer.
- Refactoring unrelated session internals.
