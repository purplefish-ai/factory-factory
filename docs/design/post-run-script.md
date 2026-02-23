# Post-Run Script Design

## Overview

Add a `postRun` field to `factory-factory.json` that runs a command in parallel after the main run script reaches the `RUNNING` state. The primary use case is launching a Cloudflare tunnel (or similar sidecar) so that dev servers on cloud machines are externally accessible.

## Motivation

When Factory Factory runs on a cloud VM, the dev server's ports aren't reachable from the developer's browser. Today the only option is to manually set up a tunnel after starting the run script. A `postRun` hook lets the project config automate this — e.g. `cloudflared tunnel --url http://localhost:{port}` — so every workspace gets remote access out of the box.

## Configuration

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev -- --port {port}",
    "postRun": "cloudflared tunnel --url http://localhost:{port}",
    "cleanup": "pkill -f 'node.*dev'"
  }
}
```

- `postRun` is optional. When absent, behaviour is unchanged.
- Supports the same `{port}` placeholder as `run` — substituted with the allocated port.

## Architecture

### Lifecycle

```
User clicks Play
  │
  ▼
RunScriptService.startRunScript()
  │  spawn run command
  │  transition state → RUNNING
  │
  ├──► ensureTunnel (existing proxy, if enabled)
  │
  └──► spawnPostRunScript()          ◄── NEW
       │  reads workspace.runScriptPostRunCommand
       │  substitutes {port}
       │  spawns bash -c <command>
       │  merges output into run script buffer
       │
       ▼
  postRun runs in parallel alongside run script
       │
  ─────┼──── User clicks Stop / run script exits ────
       │
       ▼
  killPostRunProcess()               ◄── NEW
       │  tree-kills postRun process
       │  removes from in-memory map
```

### Design Principles

1. **Sidecar, not co-equal** — `postRun` has no state machine or DB-persisted PID. It is tracked only in-memory. If it crashes, the run script continues unaffected.
2. **Fire-and-forget spawn** — `spawnPostRunScript()` is `void`-ed so it cannot block the `transitionToRunning` return or cause the start mutation to fail.
3. **Merged output** — `postRun` stdout/stderr goes into the same output buffer and is broadcast to the same WebSocket listeners. A `[Factory Factory] Starting postRun: ...` banner line distinguishes it.
4. **Killed on stop** — Ordering: cleanup script runs → main process tree-killed → postRun tree-killed.

## Data Model Changes

Add one nullable column to `Workspace`:

```prisma
model Workspace {
  // existing
  runScriptCommand        String?
  runScriptPostRunCommand String?    // NEW — the postRun command from factory-factory.json
  runScriptCleanupCommand String?
  // ...
}
```

Migration:

```sql
ALTER TABLE "Workspace" ADD COLUMN "runScriptPostRunCommand" TEXT;
```

No enum changes. No new tables.

## Schema Changes

`src/shared/schemas/factory-config.schema.ts`:

```typescript
export const FactoryConfigSchema = z.object({
  scripts: z.object({
    setup: z.string().optional(),
    run: z.string().optional(),
    postRun: z.string().optional(),   // NEW
    cleanup: z.string().optional(),
  }),
});
```

## Backend Changes

### RunScriptService (`src/backend/domains/run-script/run-script.service.ts`)

| Change | Detail |
|--------|--------|
| New field | `private readonly postRunProcesses = new Map<string, ChildProcess>()` |
| New method | `spawnPostRunScript(workspaceId, port?)` — reads `workspace.runScriptPostRunCommand`, substitutes `{port}`, spawns process, merges output |
| New method | `killPostRunProcess(workspaceId)` — tree-kills postRun and removes from map |
| Modified | `transitionToRunning` — calls `spawnPostRunScript` (fire-and-forget) after marking running |
| Modified | `handleProcessExit` — calls `killPostRunProcess` when main process exits |
| Modified | `stopRunScript` — calls `killPostRunProcess` after killing main process |
| Modified | `cleanup` / `cleanupSync` — clears `postRunProcesses` map |
| Modified | `getRunScriptStatus` — returns `runScriptPostRunCommand` in response |

### Other backend files

| File | Change |
|------|--------|
| `src/backend/resource_accessors/workspace.accessor.ts` | Add `runScriptPostRunCommand` to update input interface |
| `src/backend/domains/workspace/lifecycle/data.service.ts` | Update `setRunScriptCommands()` signature to include `postRun` |
| `src/backend/orchestration/workspace-init.orchestrator.ts` | Store `factoryConfig.scripts.postRun` on workspace creation |
| `src/backend/trpc/workspace/run-script.trpc.ts` | Pass `postRun` through in `createFactoryConfig` mutation |

## UI Changes

| File | Change |
|------|--------|
| `src/components/workspace/dev-server-setup-panel.tsx` | Add `postRun` field to config interface, form state, save handler, and JSON preview |
| `src/components/workspace/run-script-button.tsx` | Pass `postRun` in `currentConfig` prop |
| `src/components/factory-config-scripts.tsx` | Show `postRun` in both alert and card variants |

## Alternatives Considered

### A: Shell wrapper script instead of schema change

The user could write `"run": "./scripts/dev-with-tunnel.sh"` that internally starts the dev server, waits for it, and launches cloudflared. This works but:
- Requires every project to maintain a custom wrapper
- Loses the declarative nature of `factory-factory.json`
- Harder for the UI to display what's happening

### B: Reuse the existing `runScriptProxyService` tunnel

The existing `RunScriptProxyService` already starts cloudflared tunnels for run scripts with `{port}`. However it's gated behind `FF_RUN_SCRIPT_PROXY_ENABLED=1`, uses an auth-proxy layer, and is specifically designed for the built-in tunnel feature. A `postRun` hook is more general — it can run any command, not just cloudflared.

## Testing

- Update `src/backend/trpc/workspace/run-script.router.test.ts` — mock and assert `postRun` flows through `createFactoryConfig`
- Verify `pnpm typecheck`, `pnpm test`, `pnpm check:fix` pass
- Manual: set `postRun` to `echo "tunnel on {port}" && sleep 999`, start run script, confirm output appears in dev logs, stop, confirm postRun process is killed
