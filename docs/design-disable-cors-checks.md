# Design Doc: `DISABLE_CORS_CHECKS` Local Dev Flag

**Branch:** `adeeshaek/could-build-local-env-var-can` **Date:** 2026-09-30
**Status:** Draft

---

## Problem Statement

Local testing sometimes requires hitting the backend from an origin that isn't
in `CORS_ALLOWED_ORIGINS` (e.g. an alternate dev frontend, a LAN/mobile device,
or a quick curl/Postman session with an arbitrary `Origin`). Today the only
escape hatch is manually editing `CORS_ALLOWED_ORIGINS`, which is friction for a
local-only workflow. We want a single boolean env var, `DISABLE_CORS_CHECKS`,
that turns off Origin validation for local testing.

---

## Final Design Decisions

| Question                      | Decision                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Scope of bypass               | Origin validation only (Express CORS, WS upgrade, tRPC `trustedLocalProcedure`'s origin check)    |
| Loopback/trusted-CIDR checks  | Left intact — not part of "CORS," stays as a safety net for `trustedLocalProcedure`               |
| Production guard              | None — doc warning only, consistent with the existing `TRUST_PROXY_HEADERS` flag                  |
| Implementation shape          | Single centralized check in `isOriginAllowed()`, not three separate `if` checks at each call site |
| Missing `Origin` header on WS | Also allowed when the flag is set, so CLI tools (e.g. `websocat`) can connect without sending one |

---

## Codebase Findings

### CORS enforcement is centralized but has three call sites

There's no `cors` npm package — this is a custom implementation. Origin checking
happens in three independent places, all ultimately calling `isOriginAllowed()`:

1. **Express CORS middleware** —
   `src/backend/middleware/cors.middleware.ts:14-30`. Sets
   `Access-Control-Allow-Origin` only if the origin matches; always sets
   `Access-Control-Allow-Credentials: true` regardless.
2. **WebSocket upgrade validation** —
   `src/backend/routers/websocket/upgrade-utils.ts:32-60`
   (`validateWebSocketOrigin`), invoked from the shared
   `createWebSocketUpgradeHandler()` used by every channel (`/chat`,
   `/terminal`, `/setup-terminal`, `/dev-logs`, `/post-run-logs`, `/snapshots`,
   `/voice`).
3. **tRPC `trustedLocalProcedure`** — `src/backend/trpc/trpc.ts:76-96`
   (`isTrustedLocalContext`), which gates privileged mutations (workspace and
   project creation, etc.). This check requires the caller to be
   loopback/trusted-CIDR **and**, if an `Origin` header is present, that it pass
   `isOriginAllowed()`.

All three read `configService.getCorsConfig().allowedOrigins` and delegate the
actual matching to `isOriginAllowed()` in
`src/backend/lib/request-trust.ts:125-158`. A bypass needs to land in that
shared function so all three sites stay consistent — patching only the Express
middleware would leave WebSocket and tRPC still rejecting requests.

### Allowed origins today

`buildCorsConfig()` (`src/backend/services/config.service.ts:258-273`) reads
`CORS_ALLOWED_ORIGINS` (default `http://localhost:3000` /
`http://localhost:3001`). The `ff` CLI (`src/cli/serve-env.ts:8-29`)
auto-computes this per-session from the actual frontend/backend port, so the
common dev case already works without configuration — this flag is for the less
common cases that fall outside that auto-configured origin.

### Existing precedent: `TRUST_PROXY_HEADERS`

`TRUST_PROXY_HEADERS` (`env-schemas.ts:93`, default `false`) is the closest
existing analog — a boolean flag that relaxes a security-relevant check, with no
`NODE_ENV` guard in code, just a clear doc warning in `README.md:124-128`.
`DISABLE_CORS_CHECKS` follows the same pattern rather than introducing a new,
stricter convention.

### Config pattern

Per `AGENTS.md`, env vars are read only through `configService`
(`src/backend/services/config.service.ts`), never `process.env` directly. New
env vars are declared in `src/backend/services/env-schemas.ts`'s
`ConfigEnvSchema`, wrapped in `z.preprocess()` with a normalizer and
`.catch(default)`. Booleans use the existing `parseBoolean` helper (accepts
literal `'true'`/`'false'`).

---

## Implementation Plan

1. **`env-schemas.ts`** — add `DISABLE_CORS_CHECKS` to `ConfigEnvSchema` using
   `parseBoolean`, default `false`.
2. **`config.service.ts`** — add `disableCorsChecks: boolean` to `CorsConfig`
   and populate it in `buildCorsConfig()`, with a doc comment: "Local dev only —
   disables Origin validation entirely. Never enable in production or when the
   backend is reachable beyond loopback."
3. **`request-trust.ts`** — change `isOriginAllowed()` to accept the
   `disableCorsChecks` flag (either as part of a config object or an added
   parameter) and short-circuit `return true` at the top when set. Update the
   three call sites (`cors.middleware.ts`, `upgrade-utils.ts`, `trpc.ts`) to
   pass it through.
   - `trpc.ts`'s `isTrustedLocalContext` only bypasses the origin branch; the
     independent loopback/trusted-CIDR requirement is untouched.
   - `upgrade-utils.ts`'s `validateWebSocketOrigin` also stops requiring the
     `Origin` header to be present when the flag is set.
4. **`cors.middleware.ts`** — when bypassed, reflect the actual request `Origin`
   into `Access-Control-Allow-Origin` (not a literal `*`), since the middleware
   always sets `Access-Control-Allow-Credentials: true` and the CORS spec
   forbids `*` with credentials — browsers would otherwise silently drop the
   response.
5. **Docs** — add `DISABLE_CORS_CHECKS` to `.env.example` and `README.md` next
   to the `TRUST_PROXY_HEADERS` warning, stating it's local-dev-only and should
   never be set in a deployed or reverse-proxied environment.

---

## Tests

- `env-schemas.test.ts` / `config.service.test.ts`: flag parses correctly,
  defaults to `false`.
- `request-trust.test.ts`: `isOriginAllowed` returns `true` for any origin
  (including none) when the flag is set.
- `middleware.test.ts`: CORS middleware reflects an arbitrary `Origin` and still
  sets `Access-Control-Allow-Credentials: true` when the flag is set.
- `upgrade-utils.test.ts`: WS upgrade allowed with a mismatched or missing
  `Origin` when the flag is set.
- `trpc.test.ts`: `trustedLocalProcedure` still rejects non-loopback callers
  even with the flag set, but allows a mismatched `Origin` from loopback.

---

## Out of Scope

- No `NODE_ENV`/production guard — matches the existing `TRUST_PROXY_HEADERS`
  precedent; doc warning is the only enforcement.
- No change to loopback/trusted-CIDR enforcement — this flag only affects
  Origin-header validation.
