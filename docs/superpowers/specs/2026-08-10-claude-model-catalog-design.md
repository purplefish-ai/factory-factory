# Claude Model Catalog and Explicit Labels Design

## Goal

Load Claude model choices from the same Claude ACP runtime that powers Factory
Factory sessions, and show the resolved model family/version in both the Admin
default-model selector and the in-chat model selector. Keep existing configured
defaults and saved model values unchanged.

## Current Behavior and Root Cause

The two Claude model selectors currently receive their choices through different
paths:

- The Admin **Default Claude model** selector receives a static fallback list
  from `userSettings.getProviderOptions`: `sonnet`, `opus`, `haiku`, and
  `fable`. Its labels contain family names but no versions.
- The in-chat selector receives live ACP `configOptions`. Those options are
  discovered dynamically, but most labels still use unversioned display names
  such as `Opus`, `Fable`, and `Sonnet`. Only the `default` option receives
  partial special-case normalization today.

The installed `claude` command has no public model-list subcommand. The Claude
Agent SDK initialization response used by `claude-agent-acp` is the authoritative
catalog exposed by the runtime. It reports stable selection values, descriptions,
effort capabilities, and resolved model information. For example, the current
runtime reports entries whose descriptions identify `Opus 4.8 with 1M context`,
`Fable 5`, `Sonnet 5`, and `Haiku 4.5`.

The defect is therefore not that live sessions lack a catalog. It is that Admin
never asks the Claude runtime for it and that the UI-facing normalization drops
the version information the runtime already supplies.

## Approaches Considered

### 1. Ephemeral Claude ACP catalog session

This is the selected approach. Instantiate the public `ClaudeAcpAgent`, create a
temporary session with persistence and tools disabled, read its model
`configOption`, and close the session immediately. This uses the same adapter,
bundled Claude executable, environment override, settings resolution, and model
allowlist behavior as real Factory Factory Claude sessions. It requires no model
prompt and adds no package dependency.

### 2. Query the Claude Agent SDK directly

The SDK exposes the raw initialization model list, but calling it directly would
add a direct dependency and duplicate behavior that `claude-agent-acp` already
owns, including Claude settings, model allowlists, executable selection, and ACP
option construction. That duplication would make Admin discovery more likely to
disagree with live sessions.

### 3. Reuse catalogs observed from live sessions

Factory Factory could retain the latest Claude `configOptions` received from an
active session. This avoids a discovery process, but Admin would have no dynamic
catalog until a Claude session had run, and workspace-local settings could leak
into a global default selector. It does not meet the requirement reliably.

## Catalog Loader

Add a Claude catalog loader inside the session service capsule, adjacent to the
Codex model-catalog loader. It exposes a single application-facing function
through the session barrel and application context.

The loader:

1. Creates a narrow no-op ACP client implementation needed by `ClaudeAcpAgent`.
2. Initializes the agent with the client capabilities Factory Factory needs for
   option discovery.
3. Creates a session rooted at the operating system's temporary directory so
   workspace-local Claude settings cannot narrow the global Admin catalog, with:
   - `persistSession: false`;
   - `tools: []`;
   - user settings as the only SDK settings source;
   - no MCP servers.
4. Finds the `model` category in the returned `configOptions` and converts its
   flat select options into catalog entries.
5. Closes the temporary session and disposes the agent in `finally`, including
   when initialization, session creation, or catalog extraction fails.

This is a control-plane query only. It does not send a prompt, consume model
tokens, create a resumable Claude transcript, or enable tools.
Managed Claude policy remains effective; only project and local workspace
settings are excluded from the global Admin catalog.

## Label Normalization

One backend helper owns Claude model labels for both catalog discovery and live
ACP config options. Selection values are never rewritten; only display names are
normalized.

The helper takes the option's `value`, `name`, and optional `description`.
Descriptions are split at the first `·`, because Claude puts the model identity
before that separator and capability prose after it. The identity is compacted
for the selector:

- `Default (recommended)` with `Opus 4.8 with 1M context · ...` becomes
  `Default — Opus 4.8 (1M)`;
- `Opus` with the same description becomes `Opus 4.8 (1M)`;
- `Fable` with `Fable 5 · ...` becomes `Fable 5`;
- `Sonnet` with `Sonnet 5 · ...` becomes `Sonnet 5`;
- `Haiku` with `Haiku 4.5 · ...` becomes `Haiku 4.5`.

If the description is absent or does not contain a usable identity, the helper
keeps the provider-supplied name. This makes the behavior forward-compatible
with custom models and future Claude catalog shapes.

The normalization applies at every Claude ACP ingress:

- `newSession` and `loadSession` responses;
- `setSessionConfigOption` responses;
- asynchronous `config_option_update` notifications.

Normalizing notifications is required because Claude rebuilds the model option
after some setting changes. Without it, a session could start with versioned
labels and silently regress to unversioned labels after a model switch.

## Admin Provider Options

`userSettings.getProviderOptions` starts Claude and Codex discovery concurrently.
Each provider is converted independently into the existing `ProviderOptions`
shape.

On successful Claude discovery:

- `source` is `cli`;
- `models` contains the runtime-provided selection values and normalized labels;
- the existing Claude effort choices remain unchanged by this feature.

On Claude discovery failure:

- `source` is `fallback`;
- `error` contains the discovery error message;
- the current static alias and effort choices remain available.

A Claude failure does not discard a successful Codex catalog, and a Codex
failure does not discard a successful Claude catalog. The client keeps its
existing behavior of adding the currently saved value when that value is absent
from the discovered or fallback list.

## Selector Behavior

Both selectors display the normalized concise labels while continuing to submit
the original provider value:

- Admin persists values such as `sonnet`, `opus[1m]`, or
  `claude-fable-5[1m]` exactly as returned by Claude.
- In-chat selection sends the original ACP option value back through
  `setSessionConfigOption`.

The in-chat dropdown may widen to accommodate the versioned labels, while its
trigger remains bounded and truncates only when necessary. The Admin selector
continues to use the existing select control. No new details panel, tooltip, or
raw resolved-ID row is added; the approved presentation is the concise
family/version label.

This feature does not migrate `UserSettings.defaultClaudeModel`, change its
schema default, or reinterpret an existing saved alias. New and existing users
therefore keep the configured default model and cost/performance profile they
already chose.

## Testing

Tests cover these boundaries and behaviors:

- catalog extraction from a Claude ACP model config option;
- guaranteed close/dispose behavior on success and failure;
- concise formatting for default, versioned, context-window, missing-description,
  and custom model entries;
- successful Claude provider options with original values and normalized labels;
- static Claude fallback with error metadata when discovery fails;
- concurrent and independent Claude/Codex discovery outcomes;
- normalization of initial session config options;
- normalization of asynchronous mid-session config-option updates;
- Admin rendering of versioned Claude options while preserving the current
  saved value;
- in-chat rendering and selection of versioned model labels.

Focused Vitest suites run first during the red/green implementation cycles.
Completion verification includes the affected test suites, `pnpm typecheck`, and
`pnpm check`.

## Out of Scope

- Changing the default Claude model for existing or new users.
- Selecting the numerically newest model automatically.
- Persisting a shared model catalog in Prisma.
- Showing raw resolved model IDs in the dropdown.
- Adding a public model-list command to Claude CLI.
- Changing Codex catalog or label behavior beyond concurrent, independent
  discovery.
