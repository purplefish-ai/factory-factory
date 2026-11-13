# User processes omit the launcher environment

Originally decided on 2026-11-02 in #2805.

## Context

`ff serve` and the desktop app launch the backend with variables meant for
Factory Factory itself: `NODE_ENV=production`, `DATABASE_PATH`, `BACKEND_PORT`
and others. Workspace terminals and the setup, run, postRun and cleanup scripts
run the user's own commands, which inherited them. With `NODE_ENV=production`,
`npm install` skips devDependencies and dev servers start in production mode.

## Decision

Those processes start from `buildUserProcessEnv`
(`src/backend/lib/user-process-env.ts`), which drops the variables the launchers
set for Factory Factory and keeps the rest of the user's environment.

## Consequences

- A project's setup and dev server behave as they do in the user's own shell.
- Agent sessions are not covered by this filter, and neither is the project
  setup terminal (`src/backend/routers/websocket/setup-terminal.handler.ts`),
  which still starts from the full child-process environment.
- A new launcher variable must be added to the list in `user-process-env.ts`, or
  user commands will inherit it.
