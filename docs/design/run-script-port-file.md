# Design: Run script port file

## Problem

When the run script (`pnpm dev`) starts a dev server, the `postRun` command (e.g., `cloudflared tunnel --url http://localhost:{port}`) needs to know which port the dev server is listening on. Currently, `{port}` is only substituted when the `run` command itself contains `{port}`, because that's what triggers Factory Factory to allocate a port via `PortAllocationService.findFreePort()`.

For projects like Factory Factory where the dev server picks its own port (e.g., `pnpm dev` starts Vite on port 3000 and backend on 3001), `{port}` is never allocated, so the postRun command receives the literal string `{port}`.

## Solution

The dev server (CLI `serve` command) writes a `.factory-factory-port` file to its working directory after startup. The postRun shell command reads this file directly — all port-discovery logic lives in the shell command, not in the app's TypeScript code.

### Port file

- **Path**: `{worktreePath}/.factory-factory-port`
- **Contents**: Just the port number as a string (e.g., `3000\n`)
- **Lifecycle**: Written by the dev server on startup. Deleted on shutdown.
- **Gitignore**: Add `.factory-factory-port` to `.gitignore`.

### PostRun command

The postRun command in `factory-factory.json` handles polling and reading the port file itself:

```
while [ ! -f .factory-factory-port ]; do sleep 0.5; done; cloudflared tunnel --url http://localhost:$(cat .factory-factory-port)
```

No changes to `spawnPostRunScript` in the app — the shell command does all the work.

## Changes

### 1. CLI writes port file on startup — `src/cli/index.ts`

In the `createOnReady` callback, after printing the ready banner, write the port file:

```typescript
const portFilePath = join(process.cwd(), '.factory-factory-port');
await writeFile(portFilePath, frontendPort.toString(), 'utf-8');
```

In the shutdown handler, delete the port file.

### 2. Gitignore — `.gitignore`

Add `.factory-factory-port` to the project's `.gitignore`.

### 3. Update `factory-factory.json`

Change the postRun command to poll for the port file:

```json
{
  "scripts": {
    "postRun": "while [ ! -f .factory-factory-port ]; do sleep 0.5; done; cloudflared tunnel --url http://localhost:$(cat .factory-factory-port)"
  }
}
```

## Example flow

1. User clicks play button in workspace
2. Run script service spawns `pnpm dev` in the worktree
3. `pnpm dev` calls `tsx src/cli/index.ts serve --dev`
4. CLI starts backend on port 3001, frontend on port 3000
5. CLI writes `3000` to `{worktree}/.factory-factory-port`
6. Run script transitions to RUNNING, fires `spawnPostRunScript`
7. PostRun shell command polls for `.factory-factory-port`, reads `3000`
8. Spawns `cloudflared tunnel --url http://localhost:3000`
9. On stop: processes are killed, port file is deleted by CLI shutdown handler
