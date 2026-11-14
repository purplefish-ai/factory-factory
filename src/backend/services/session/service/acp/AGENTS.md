# ACP module

The Agent Client Protocol side of a session: the Claude Code and Codex adapter
processes, the protocol connection to them, starting, prompting and stopping a
runtime, and the disposable provider processes that discover model catalogs,
launch options and plan usage. The [capsule guide](../../AGENTS.md) covers the
capsule, and `../../modules.ts` describes this module in one line. This guide
does not yet cover prompts, steering, stops or subagents. Bare file names below
are in this directory; paths that start with `src/` are from the repository
root.

## Owns, and does not own

The module owns the adapter processes and everything said to them over ACP. It
does not own:

- Which model, access and planning a session should have, live edits and their
  persistence: `../config/`. The module applies only the startup model it is
  given.
- The model catalog caches and when they refresh: `../providers/`.
- When a runtime starts or stops: `../lifecycle/`.
- The update gate that admits ACP work,
  `src/backend/services/application-update-admission.service.ts`. The module
  imports no application code beyond a short allowlist
  (`acp-no-external-imports`, `pnpm deps:check`), so the application graph
  passes `applicationUpdateAdmission` to `configureAdmission` before startup
  (`src/backend/app-context.ts`); until then all work is admitted.
- Which permission requests are answered automatically, and the queue of
  requests shown to the user: `../events/session.permission.service.ts`.
- The MCP server that child workspace tools run in:
  `src/backend/mcp/workspace-mcp-server.ts`. The module only builds its spawn
  configuration (`child-workspace-mcp-server.ts`).
- The `ff claude` and `ff codex` commands and the provider health checks:
  `src/cli/`, `src/backend/orchestration/cli-health.service.ts`, and the bundled
  command resolution in `src/backend/lib/claude-cli-command.ts` and
  `src/backend/lib/codex-cli-command.ts`.

## Public surface

`index.ts` exports `AcpRuntimeManager` and its singleton `acpRuntimeManager`,
`AcpProcessHandle`, the permission bridge, the runtime event types, and the
loaders `fetchClaudeModelCatalogFromAcp`, `fetchCodexModelCatalogFromAppServer`
and `fetchSessionLaunchOptionsFromAcp`. Sibling modules also import some files
here directly.

## Invariants

- A session runtime's adapter is spawned only after its working directory is
  confirmed to exist and to be a directory.
  `acp-runtime-manager.working-dir.test.ts`, `acp-working-directory.test.ts`.
- A runtime started with a model is returned only once the provider confirms
  that model through its advertised model option; a model that is neither
  advertised nor already current, or that is unconfirmed, fails the start
  instead of keeping another model (Codex's `default` means its current native
  model, and a Claude family alias resolves only to a single advertised
  identity), and a browse-only runtime changes no configuration.
  `acp-model-selection.test.ts`, `acp-runtime-manager.model-selection.test.ts`.
- The startup model configuration runs under the session creation deadline
  (`ACP_SESSION_CREATION_TIMEOUT_MS`), not the handshake's.
  `acp-client-factory.startup-deadlines.test.ts`,
  `acp-runtime-manager.model-selection.test.ts`.
- A runtime sends no prompt until its configuration readiness opens, however
  long setup takes, and a failed setup rejects its prompts for good.
  `acp-runtime-manager.readiness.test.ts`.
- A form or URL elicitation (`acp-elicitation.ts`) is accepted only when the
  user picks its accept option, a form only with answers its schema accepts (an
  unsupported pattern fails closed), and stopping the session cancels it.
  `acp-elicitation.test.ts`.
- The model catalog loaders and the launch options probe never start a turn:
  Claude's loader opens a session with no tools and closes it, Codex's only
  lists models from the app server, and the probe rejects permission and
  elicitation requests. `claude-model-catalog-loader.test.ts`,
  `codex-model-catalog-loader.test.ts`, `session-launch-options-probe.test.ts`.
- A catalog loader or the probe reports its child drained only on the child's
  `close` (its pipes closed), the probe also only after its ACP connection
  closes, whatever happened to the caller.
  `claude-model-catalog-loader.test.ts`, `codex-model-catalog-loader.test.ts`,
  `session-launch-options-probe.test.ts`,
  `../config/session-launch-options-drain.test.ts`.

## Map

- `acp-connection.ts`: registers the client handlers with the SDK and wraps each
  request to the agent, for runtimes and probes alike. It uses the SDK's
  `/unstable` entrypoint, which keeps elicitation and native subagents.
- `acp-runtime-spawn.ts`: the adapter command (the package entrypoint run with
  the host Node, Electron's included), working directory validation, deadlines
  and catalog process termination.
- `acp-client-factory.ts`: spawn, handshake, session creation, load or resume,
  and the startup model (`acp-model-selection.ts`).
- `acp-runtime-manager.ts`, `acp-runtime-supervisor.ts`: the runtime per
  session, its creation, prompts and stops; `acp-prompt-readiness.ts`, its
  configuration readiness.
- `acp-session-config-options.ts`: normalizes the provider's configuration
  options, deriving them from the older model and mode fields when absent.
- `acp-runtime-errors.ts`: runtime errors, including the resume error that keeps
  the provider's message, code, details and cause.
- `claude-model-catalog-loader.ts`, `codex-model-catalog-loader.ts`,
  `session-launch-options-probe.ts`, `claude-plan-usage-loader.ts`,
  `codex-plan-usage-loader.ts`: disposable discovery processes.

## Decisions

- [ACP session creation has its own deadline](../../../../../../docs/decisions/2026-11-13-acp-session-creation-has-its-own-deadline.md)
