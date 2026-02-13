# Codex App Server Schema Verification

This module depends on the Codex CLI app-server wire schema, which can change over time.

Use this checklist whenever `codex-cli` is upgraded or Codex integration behavior changes.

## 1) Capture current CLI schema

```bash
codex --version
rm -rf /tmp/codex-ts-schema
mkdir -p /tmp/codex-ts-schema
codex app-server generate-ts --out /tmp/codex-ts-schema
```

Primary generated files to inspect:
- `/tmp/codex-ts-schema/ClientRequest.ts`
- `/tmp/codex-ts-schema/ServerRequest.ts`
- `/tmp/codex-ts-schema/ClientNotification.ts`
- `/tmp/codex-ts-schema/v2/ThreadStartParams.ts`
- `/tmp/codex-ts-schema/v2/TurnStartParams.ts`
- `/tmp/codex-ts-schema/v2/TurnInterruptParams.ts`
- `/tmp/codex-ts-schema/v2/CommandExecutionRequestApprovalResponse.ts`
- `/tmp/codex-ts-schema/v2/FileChangeRequestApprovalResponse.ts`
- `/tmp/codex-ts-schema/v2/ToolRequestUserInputResponse.ts`

## 2) Compare schema against our implementation

Core transport/manager:
- `src/backend/domains/session/runtime/codex-app-server-manager.ts`
- `src/backend/domains/session/codex/types.ts`

Provider mapping:
- `src/backend/domains/session/providers/codex-session-provider-adapter.ts`
- `src/backend/domains/session/codex/codex-event-translator.ts`

Validation tests:
- `src/backend/domains/session/runtime/codex-app-server-manager.test.ts`
- `src/backend/domains/session/providers/codex-session-provider-adapter.test.ts`
- `src/backend/domains/session/codex/codex-event-translator.test.ts`

## 3) High-risk drift points

Verify these first:
- Request/response envelope shape (do not assume `"jsonrpc": "2.0"` exists).
- Request id type (`string | number`).
- `initialize` params and `initialized` notification shape.
- `thread/start` required params (for example `experimentalRawEvents`).
- `turn/start` input shape (`input` is typed array, not raw string).
- `turn/interrupt` required fields (requires `turnId`).
- Approval decision enums for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
- `item/tool/requestUserInput` answer payload nesting.

## 4) Quick method scan command

```bash
rg -n "method\": \"(initialize|thread/start|thread/resume|thread/read|turn/start|turn/interrupt|item/commandExecution/requestApproval|item/fileChange/requestApproval|item/tool/requestUserInput|initialized)\"" \
  /tmp/codex-ts-schema/ClientRequest.ts \
  /tmp/codex-ts-schema/ServerRequest.ts \
  /tmp/codex-ts-schema/ClientNotification.ts
```

## 5) Schema drift snapshot harness

Snapshot source file:
- `src/backend/domains/session/codex/schema-snapshots/app-server-methods.snapshot.json`

Commands:

```bash
pnpm check:codex-schema
pnpm check:codex-schema:update
```

- `check:codex-schema` fails when generated methods differ from snapshot.
- `check:codex-schema:update` refreshes snapshot after intentional `codex-cli` upgrade.

## 6) Required verification run

```bash
pnpm check --silent
pnpm typecheck
pnpm test
pnpm deps:check
```

If behavior changed, add/adjust targeted Codex tests first, then run the full suite.
