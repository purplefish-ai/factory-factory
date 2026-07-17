# Transport-Neutral Application Errors Design

## Goal

Remove runtime tRPC dependencies from backend services and orchestration while preserving client-visible tRPC codes, useful messages, internal causes, and dependency-boundary enforcement.

## Approaches Considered

1. Use one `ApplicationError` class with stable application codes and translate it in shared tRPC middleware. This is the selected approach because non-transport callers get one small contract and all tRPC procedures share one exhaustive mapping.
2. Define a separate error subclass in every service capsule. This gives stronger domain naming but adds boilerplate without changing how callers handle these failures.
3. Catch and translate application errors in each router. This keeps mapping close to individual procedures but duplicates transport policy and can drift as callers are added.

## Architecture

`src/backend/lib/application-error.ts` defines a transport-neutral `ApplicationError`. Its stable codes are `INVALID_INPUT`, `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT`, and `INTERNAL_ERROR`. The class retains its message and optional `cause`, allowing CLI, Electron, orchestration, and tests to inspect failures without importing tRPC.

`src/backend/trpc/application-error-mapper.ts` owns the exhaustive application-to-tRPC mapping. `INVALID_INPUT` maps to the existing `BAD_REQUEST` transport code; the other public codes map directly; `INTERNAL_ERROR` maps to `INTERNAL_SERVER_ERROR`. It creates `TRPCError` only inside the transport layer and retains the `ApplicationError` as the transport error cause.

The base `publicProcedure` uses middleware to translate errors once for all tRPC callers. tRPC v11 returns downstream failures from `next()` as an unsuccessful result, so the middleware inspects `result.error.cause` rather than relying only on `try/catch`. Existing tRPC errors and unknown errors pass through unchanged. The bulk-archive procedure, which intentionally catches individual failures instead of allowing middleware to see them, uses the same mapper to report each result code.

## Service and Orchestration Changes

The four production files currently importing `@trpc/server` will throw `ApplicationError`:

- `git-ops.service.ts`: command failures use `INTERNAL_ERROR`; dirty worktrees use `PRECONDITION_FAILED`.
- `creation.service.ts`: existing `BAD_REQUEST` cases use `INVALID_INPUT`; missing records use `NOT_FOUND`.
- `workspace-archive.orchestrator.ts`: cleanup failure uses `INTERNAL_ERROR`; an invalid transition uses `INVALID_INPUT`.
- `workspace-children.orchestrator.ts`: a missing project uses `NOT_FOUND`.

No semantically tempting transport-code changes are included. For example, an already-checked-out branch remains a tRPC `BAD_REQUEST` via `INVALID_INPUT`, preserving existing callers.

## Sensitive Error Details

Git status, add, and commit failures keep short public messages that name the failed operation but omit stdout and stderr. The original command result is stored only in `ApplicationError.cause`. Runtime cleanup similarly uses an aggregate cause while returning only the operation-specific generic message to tRPC clients.

## Dependency Boundary

Dependency Cruiser will reject `@trpc/server` imports originating anywhere under `src/backend/services/` or `src/backend/orchestration/`. The target expression covers direct npm installs and pnpm's nested package layout. tRPC-layer, client type-only, and server-adapter imports remain allowed.

## Testing

- Unit-test application error fields and cause preservation.
- Test the exhaustive mapper for every stable application code.
- Test shared procedure middleware through a tRPC caller, including message/cause preservation and pass-through behavior.
- Update service and orchestration tests to assert application codes rather than tRPC types.
- Verify raw git command output is absent from the public message and retained only in the cause.
- Update bulk archive coverage to throw an application error while returning the existing tRPC code.
- Run dependency checks, type checking, the full test suite, and production build.

## Edge Cases

- Unknown exceptions remain tRPC internal errors.
- Existing tRPC-layer `TRPCError` instances retain their original codes.
- Errors caught inside a procedure, such as per-item bulk archive failures, explicitly use the centralized mapper.
- Multiple runtime cleanup failures remain available to internal diagnostics without exposing their messages to transport clients.
