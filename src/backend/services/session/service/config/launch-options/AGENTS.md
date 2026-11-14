# Launch options cache

What each provider offers a new session (model, reasoning, access mode and plan
mode), discovered by a disposable probe and saved across restarts. Part of the
session configuration module: its [guide](../AGENTS.md) covers the rest, and
`../session.config.service.ts` builds and serves this cache. Bare file names
below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

The directory owns the launch options cache. It does not own:

- The launch options probe: `../../acp/`.

## Invariants

- Launch options are cached per provider, model and the requested Codex account
  (or Auto), 128 at most, by at most eight discoveries, each holding its slot
  until its child drains (`stopLaunchOptions()` waits seven seconds at most); a
  result over five minutes old is returned at once and refreshed in the
  background if it has no discovery running and a slot is free; a failed refresh
  keeps it, and the next waits 30 s. `session-launch-options.service.test.ts`,
  `session-launch-options-cache.test.ts`,
  `session-launch-options-drain.test.ts`.

## Map

- `session-launch-options.service.ts`: the launch options cache, saved by
  `session-launch-options-store.ts`.
- `session-launch-options-provider.ts`: resolves a Codex account's environment
  and calls the probe.
