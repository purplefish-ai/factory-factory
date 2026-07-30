# Valid Port Start Design

## Problem

The CLI and backend `findAvailablePort` helpers accept any numeric starting value and only stop once a candidate exceeds `65_535`. A starting value of `0` can therefore be reported as available. In development mode the CLI passes that value to Vite, which treats port `0` as a request for an OS-assigned ephemeral port, while the CLI still waits for a service on port `0`. The resulting timeout falsely reports a frontend startup failure.

## Decision

Both reusable port finders will validate `startPort` before probing. A valid starting port must be an integer in the inclusive TCP user-assignable range `1..65_535`. Invalid input will throw:

```text
Invalid start port <value>: expected an integer between 1 and 65535
```

The validation will live at both existing finder boundaries rather than only in the CLI option parser. This keeps CLI and backend behavior consistent and protects all direct callers. Valid inputs will retain the current sequential scan, exclusion handling, maximum-attempt behavior, and upper-bound stop.

## Alternatives Considered

1. Validate only `ff serve` options. This would fix the reported command but leave both general-purpose helpers able to return invalid ports.
2. Treat port `0` as an intentional request for an ephemeral port. This would require discovering and propagating the actual bound port from Vite and other child processes, which is outside the current finder contract.
3. Validate both finders before probing. This is the selected approach because it is small, consistent with `PortAllocationService.findFreePort`, and fails immediately with an actionable error.

## Tests

Focused tests in `src/cli/runtime-utils.test.ts` and `src/backend/services/port.service.test.ts` will cover invalid values below, above, and between integer ports. Each test will assert both the clear rejection and that no `lsof` probe occurs. Existing tests continue to cover valid scanning, attempt limits, and stopping at `65_535`.

## Scope

This change does not alter UI behavior, port option defaults, successful port allocation, or the meaning of `maxAttempts`. No screenshots, database changes, or documentation updates outside this design and implementation plan are required.
