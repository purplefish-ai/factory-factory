# IPv6 Wildcard Serve CORS Design

## Goal

Ensure `factory-factory serve --host` produces a valid default browser origin when the backend binds to any supported IPv4 or IPv6 all-interfaces address.

## Design

Keep the backend bind host unchanged, because `0.0.0.0`, `::`, `::0`, and `0:0:0:0:0:0:0:0` are valid server bind addresses. When `buildServeEnv` derives `CORS_ALLOWED_ORIGINS`, map only those wildcard addresses to `localhost`; continue using the requested host for all other values. Preserve an explicit `CORS_ALLOWED_ORIGINS` supplied through the base environment.

The normalization remains local to `src/cli/serve-env.ts`, where the malformed URL originates. No downstream CORS parser changes are needed because it correctly rejects malformed origins and already treats valid loopback origins as equivalent.

## Testing

Extend `src/cli/serve-env.test.ts` with table-driven coverage for the three IPv6 wildcard spellings in production mode and one IPv6 wildcard case in development mode. Assert both that `BACKEND_HOST` retains the requested bind value and that the generated origin uses `localhost` with the appropriate backend or frontend port. Existing tests continue to cover IPv4 wildcard behavior, ordinary hosts, and explicit environment overrides.

## Scope

This is a CLI environment-construction fix only. It does not change network binding, CORS parsing, UI behavior, or configuration schemas.
