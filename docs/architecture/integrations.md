# Integrations

The sections that preceded "Event-triggered automation data model" have moved.
Ownership, public surface, invariants and file maps are in the guides beside the
code: [GitHub capsule](../../src/backend/services/github/AGENTS.md),
[Linear capsule](../../src/backend/services/linear/AGENTS.md) and
[periodic-task capsule](../../src/backend/services/periodic-task/AGENTS.md). The
reasons are in the `2026-11-13-*` records in [decisions](../decisions/), and the
tests those guides name describe the behaviour. The sections below have not been
migrated yet.

<a id="scheduled-automations"></a>Links here with this anchor were for scheduled
automations: the
[periodic-task capsule guide](../../src/backend/services/periodic-task/AGENTS.md).

## Event-triggered automation data model

The data model, "Enable and pause", "Source reset" and "Delete" have moved to
the
[agent-definition capsule guide](../../src/backend/services/agent-definition/AGENTS.md)
and the guide and records it links; the tests they name describe the behaviour.

<a id="enable-and-pause"></a><a id="source-reset"></a><a id="delete"></a>Links
here with these anchors were for Enable and Pause, source reset and Delete: the
[agent-definition capsule guide](../../src/backend/services/agent-definition/AGENTS.md).

### Project-owned saved management

Trusted-local `automation.list`, `get`, `updateSaved`, `evaluations`, `runs`,
and `navigationSummary` procedures manage project-owned event definitions even
after the authoring workspace/proposal is deleted. Inputs carry project
ownership; foreign IDs are not found. History uses bounded timestamp/ID keyset
pages (50 by default, at most 100), with independent evaluation and run pages.
Navigation counts every definition and its latest terminal event-run outcome
independently of those pages. Archived projects remain readable; writes and
discovery require an active project. Scheduled automation APIs and routes retain
their existing behavior.

`automation.list`, `runs` and `evaluations` accept the optional
`direction: "forward"` metadata added by tRPC infinite queries and remove it
before domain validation. Pagination remains forward-only; unrelated input
fields are still rejected.

`managementRevision` is the shared optimistic save token. Both saved replacement
and accepted-proposal edits increment it once, including a rename/no-op. Saved
edits also synchronize a surviving proposal's revision and local-ID
specification, so a stale editor on either surface conflicts. Execution
`definitionRevision` still changes only for task/execution edits; claimed
snapshots are immutable. Saved trigger IDs are persisted IDs, not proposal-local
IDs. Omitted IDs create new members; omitted existing members retain their
history rows.

Nullable `AgentTrigger.isConfigured` distinguishes current (`true`), removed
(`false`), and unknown legacy (`null`) membership. Migration does not infer
membership from PAUSED, ACTIVE, enabled flags or old runs. Any unknown row makes
the exact configuration unavailable; bounded candidate records remain
inspectable. A complete saved replacement establishes the entire membership set.
Included unknown or reintroduced removed rows take the changed-trigger path:
advance trigger revision and activation generation, pause, clear
pending/boundary proof, and cancel affected queued/PENDING work. Known unchanged
members preserve activation on rename. Historic actor restrictions remain
visible with an unsupported reason and require explicit removal in a
replacement. A valid complete save can replace malformed previous trigger or
execution configuration; it follows the same revision, pause and queued-work
invalidation rules. Invalid new input is still rejected.

`projectSources` shares the authoring source policy: actual project repository,
repository-scoped GitHub connection and verified labels; existing Slack bot
connection/channel access. No display name proves access. Project/connection
facts are rechecked after source awaits and inside save transactions. Slack
discovery rechecks enabled credentials and workspace identity after channel and
repository lookups; stale selected channels fail, and stale connections are
removed from the discovery list. Connections remain global installation
identities rather than gaining a project foreign key.

Explicit `validateDraft` is a POST mutation so full draft instructions travel in
the request body. It returns per-trigger capability reasons and a separate
native validation result. It uses the configured public session launch-options
service, including its bounded no-prompt discovery/cache, native model
confirmation and Codex preview-account isolation. Intent preserves requested and
confirmed models, explicit/inherited selections, and pinned reasoning effort.
Unsupported explicit effort fails; unsupported/absent inherited effort
normalizes to a supported native default or explicit null. This preview neither
freezes a future run account nor authorizes activation; Enable repeats the same
validation on the server. Ordinary reads never invoke native discovery. Only
labeled and reopened GitHub events can pass this milestone's source
capabilities; other GitHub actions (`opened`, `edited`), Slack intake, SCHEDULE
and actor filters report specific unsupported/unavailable reasons while
remaining inspectable drafts. Natural-language `filterInstructions` report
`UNSUPPORTED_SEMANTIC_FILTER` unless the automation's provider passed the live
classifier gate. Draft validation and Enable check the provider resolved at that
moment, including an inherited one; ordinary reads do not resolve providers, so
they report an inherited provider as supported only when every provider passed.

History exposes bounded reasons, nullable start times, separate automatic
attempts and send generations, preparation/delivery state and durable deadlines,
immutable initial outcome, compact result/PR links and retained workspace
provenance. An evaluation's `explanation` is returned only when it is one of the
fixed sentences the system writes (`agent-evaluation-explanations.ts`), which
carry no event text, provider output or credentials; any other stored text reads
as null. History excludes raw prompts, provider evidence and unrestricted
errors. Pruned event text or a null event FK does not erase run identity or
prove completion. The workspace owner's retained-origin read covers creation
before linkage and deletion; it is provenance, not work proof or permission to
retry setup. Public history confirms LIVE only through that retained-origin
owner; a live run FK with missing reservation or origin returns a bounded
NOT_FOUND. Never-created reservations remain RESERVED, and runs without
workspace claims remain UNRESERVED. LIVE means an extant owner-validated
workspace row, including archived rows; it does not mean ready or running. Null
result/preparation metadata means no validated public metadata is available, not
an empty result, completion or cleanup.

The saved event detail/editor consumes these project-owned APIs independently of
its authoring workspace/proposal. It displays saved instructions, execution
settings, configured versus retained trigger records and each trigger's state in
words (see [Enable, Pause and Reset source](#event-activation-controls)), with
stored codes, revisions and inspected raw JSON in collapsed **Details**
sections; the editor keeps its editable JSON fields visible. Editing captures
managementRevision once; polling and CAS conflicts preserve all entered fields
and the original token. Reloading is deliberate. Saved edits invalidate the
captured owner and matching surviving proposal cards; proposal edits refresh the
same saved owner.

A complete valid specification initializes the field/JSON editor without
rewriting inherited execution omissions. Unknown membership, null or invalid
stored configuration starts as read-only inspection. An explicit complete
replacement starts with a blank full-specification JSON input, validated by the
saved schema. It never reconstructs membership from retained pages or silently
removes historical actor restrictions. Source refresh and native validation are
explicit user actions; validation is a POST preview of the current full draft
and grants no activation or account authority. Late previews cannot certify
newer drafts. Archived details remain readable with writes/previews disabled.

<a id="event-runs-and-events"></a>

Below the saved detail, **Runs** and **Events** tabs read `automation.runs` and
`automation.evaluations`, newest first, 50 per page with **Load more**. Both
poll at the management cadence; a refresh reloads every loaded page from the
first cursor, so new runs never open a gap. Both views use tRPC's own infinite
queries. A failed refresh or next page keeps loaded rows with a retry notice; a
failed first read shows an error, never an empty state. Saved edits invalidate
both views.

A run shows its status in words (Queued, Starting, Running, Needs attention, PR
created, Completed, Failed, Cancelled), a readable phrase for its reason code
(the code stays in the phrase's title and a collapsed **Details** section with
identifiers, attempts and first-message state), queue expiry or next attempt
while active, retained PR links and summary, and expired run context. Only a
LIVE workspace state links to a workspace; otherwise an active run says no
workspace yet and a finished one says workspace deleted (DELETED), no workspace
was created (UNRESERVED) or workspace unavailable (RESERVED). A null result is
shown as nothing and a null event link reads "Event record no longer kept" in
Details; neither is presented as empty or completed. A RUNNING run in
`NEEDS_ATTENTION` reads Needs attention, including one marked resolved
(`EXPLICITLY_RESOLVED`), because Resolve keeps the run and its slot. An event
row shows Matched, Skipped or Error, its trigger's description (or ID when the
trigger is outside the loaded definition), a phrase for its reason, whether it
started a run, and any next attempt. Beneath the phrase it shows the stored
`explanation` when that says more: for a code without a phrase, for
`LABEL_MISMATCH`, `SOURCE_IDENTITY_MISMATCH` and `QUEUE_OVERFLOW`, whose
explanation says which case applied, and for `SEMANTIC_FILTER_PROVIDER_UNPROVEN`
and `SEMANTIC_FILTER_TOO_LONG`, whose explanation names the provider or the
length limit.

<a id="event-run-recovery"></a>

A RUNNING run in `NEEDS_ATTENTION`, or still open after its first turn ended
(held by unproven work or child workspaces), shows **Inspect**, disabled in an
archived project. Inspect reads `automation.recoveryTarget` and then
`automation.inspectRun` with that exact context, only when opened and afresh on
each opening; neither polls. The dialog shows the first message's delivery
state, whether the agent is proven stopped, any child hold (held count, each
held child as a workspace link with Working or Not started, and the 24-hour
deadline at which the run ends on its own), and Resolve, Retry and Abandon. Only
actions the inspection allows have buttons: a common `blocked` reason removes
all three with that reason in words, a child hold leaves only Abandon, and
`retryBlocked` removes only Retry; each missing action says why. A blocked run
whose inspection reports `unprovenAbandonAvailable` offers **Abandon anyway**
instead (otherwise the dialog says no recovery action is available). Its dialog
says Factory Factory can't confirm the agent stopped; that abandoning ends the
run anyway and frees its slot; that an agent still running keeps working in its
workspace until someone stops it there, so check the workspace; and that the run
keeps the result of its own first turn when the fresh inspection shows a
finished first message (Completed, PR created or Failed), and is otherwise
recorded as Cancelled. It sends ABANDON with `acceptUnprovenStop: true`
([abandon without proof](agent-runtime.md#abandon-without-proof)); an ordinary
Abandon never sends the opt-in. The result line warns that the agent may still
be running only when the server answers `unproven: true`; the server still takes
the proven path when proof turns up. Such a run then reads with that status and
the `ABANDONED_UNPROVEN` reason phrase. Each action opens a `ConfirmDialog`.
Resolve says it stops the agent and keeps the run, as Needs attention, holding
its slot until Retry or Abandon. Retry warns that earlier effects may already
have happened (the first message may have reached the agent) and keeps the slot
and attempt count. Ordinary (proven) Abandon says it frees the slot, how the run
is recorded (Cancelled, or Failed after a failed first turn; with a child hold
and `keepsOutcome`, the first turn's own outcome), and that child workspaces are
not stopped. The action sends the inspected context unchanged. A `CONFLICT` or
`BLOCKED` result keeps the dialog open, says the run's status did not change and
offers only **Reload**, which reads the target again; nothing is resent
automatically. Success shows a result line on the run and refreshes the history,
workspace origin, automation detail, list and navigation summary.

An event-run workspace (`creationSource` `EVENT_AGENT`) reads
`automation.workspaceOrigin`; other workspaces never call it. Its **Runs** tab
is shown while that read is pending or failed (with loading or error states) and
whenever it returns a run; an origin without a retained run removes the tab, as
deleting a scheduled automation does. The panel shows the automation's name, the
run that started the workspace, and a link to the event automation.

<a id="event-activation-controls"></a>

The saved detail has **Enable** and **Pause**, with the Active/Paused words of
scheduled automations: the header reads Active while any trigger listens,
Starting while one is still starting, and Paused otherwise. Both send the loaded
`managementRevision` to [enable and pause](#enable-and-pause). Which buttons
show, and every displayed state, comes from the triggers rather than the
definition flag, because an edit, an expiry or a source reset leaves the
definition enabled with every trigger paused. Each configured trigger reads
Listening (enabled and `ACTIVE`), Starting (`STARTING`), Paused (with
`pausedReasonCode` in words), or Can't run (capability not `SUPPORTED`, with its
`explanation`, as for Slack, schedule, actor filters, GitHub `opened`/`edited`,
and natural-language filters whose provider has not passed the classifier gate).
Source health is shown in words, including the `GITHUB_SOURCE_RESET` and
`GITHUB_BASELINE_REQUIRED` states after a reset and Enable. Enable can take a
few seconds while the server validates; a `PRECONDITION_FAILED` shows its
reasons inline, and a `CONFLICT` keeps the page and offers **Reload
automation**. The detail polls at the management cadence, so Starting moves to
Listening or Paused after the next source poll cycle. Pause states that queued
runs are cancelled, started runs continue, and events while paused never run.
The rail uses the same rule: each `automation.list` item carries
`triggerStates`, its configured triggers counted as listening (`ACTIVE` and
enabled), starting (`STARTING`) or paused (the rest), from one grouped query per
page, so the rail reads Active, Starting or Paused without loading each
automation. The editor still says which edits pause triggers; Enable restarts
them after saving.

A GitHub source in `RECOVERY_REQUIRED` shows one **Reset source** callout per
connection. Its `ConfirmDialog` says that events from the gap will not run, that
every automation on the source is paused (including other projects) with queued
runs cancelled, and that each automation needs Enable again; a failure stays in
the dialog. Success reports the paused-trigger and cancelled-run counts and
invalidates every cached automation read, list and history in every project,
because the reset reaches other projects on the same source. Enable, Pause and
Reset source are disabled in archived projects.

The detail's **Delete** opens a `ConfirmDialog` that names what is removed (the
triggers, run and event history, and the saved proposal) and what is kept
(workspaces its runs started, with their chats and pull requests). It sends the
loaded `managementRevision` to [delete](#delete). A refusal while a run is
unfinished stays in the dialog with the server's reason, and a `CONFLICT` offers
**Reload automation** there. Success removes the automation from the list,
returns to the event automations list, refreshes the list, rail count and
workspace origins, marks the automation's own reads stale without refetching
them, and resets any chat proposal card for it. Delete is disabled in archived
projects. Scheduled CRUD and history retain their existing behavior.
[Run recovery](#event-run-recovery) uses the separate trusted-local
exact-context transport described in
[agent runtime](agent-runtime.md#exact-context-operator-recovery-transport).
Production authoring still creates paused definitions. Manually altered
ACTIVE-looking legacy records without known membership or a current validated
intent never target, evaluate, admit or claim. Trusted-local HTTP uses existing
locality/origin/forwarding checks, not authenticated human-versus-agent
isolation. The MCP catalog still exposes only source discovery/proposal
authoring/read tools.

### Conversational creation

Workspace sessions expose `list_automation_sources`, `propose_automation`, and
`get_automation_proposal` through their existing MCP server. The workspace agent
interprets the user's request, discovers resource IDs, and proposes a structured
configuration. Slack discovery lists bot-member public/private channels with
pagination. GitHub discovery resolves the current project's repository and
labels through the authenticated `gh` CLI; its connection identity is
repository-scoped (`gh:<repository-id>`), not a GitHub App installation or an
event subscription. Missing GitHub access does not prevent Slack authoring.
Actor-specific ID restrictions are rejected until actor discovery is supported.
The `propose_automation` guidance proposes only the GitHub actions that can be
enabled, `labeled` and `reopened`; GitHub records labels applied when an issue
is created as `labeled` events. It states that `opened` and `edited` are not yet
supported. Both discovery and proposal descriptions say that a created
automation starts paused, that only the user enables it from the Automations
page (the agent cannot enable, pause or run it), that GitHub `labeled` and
`reopened` triggers run once enabled, and that Slack triggers run only when
Slack event intake is turned on and the user has posted the test message in each
selected channel.

`AgentProposal` persists the specification, verified display names, workspace,
revision, and optional created definition. Tool results carry a proposal
reference with type `automation_proposal`; chat loads its current state and
renders an editable card outside the collapsed activity group. Saved chats with
legacy tool names and the `agent_proposal` discriminator still render their
proposal cards. Users can edit instructions, filters, event settings, and
execution settings. **Create automation** atomically creates a paused definition
and its paused triggers. The card says the automation is created paused and is
enabled from the Automations page, and that only GitHub `labeled` and `reopened`
issue triggers can run today. Creation does not start legacy periodic tasks.

Conversational edits use optimistic revision checks and cannot silently replace
a newer proposal. A widget that receives a newer revision refreshes its data;
loading that revision combines conversational changes with local field edits.
Local values take precedence for task/execution fields edited on both sides. If
both sides changed events, loading stops and preserves local edits until the
user explicitly discards them; positional merging could move a filter to a
different source. Creation retries return the existing definition only when the
accepted revision and specification match. Saved configurations remain editable
through **Edit automation** / **Save changes** on the same card; updates
preserve stable event IDs and historical run snapshots, including across removal
and reordering. Removed events are paused, preserving history. The MCP catalog
does not expose commit operations; creation and saved automation updates are
user actions through trusted local API procedures.

Proposals belong to their authoring workspace and are removed with it; created
definitions belong to the project and survive workspace deletion. Deleting a
saved definition also removes its accepted proposal. Logical export/import
recovers definition bodies and supported execution preferences as disabled
records, preserving both revisions and timestamps. It omits connections, event
configuration, proposal provenance, activation and automation execution history.
Ordinary agent inspection can read recovered bodies with no configured events.
The existing explicit complete replacement editor can author fresh events where
project/revision editing rules allow; archived projects and exhausted revisions
retain their restrictions. No timer or event activation authority is restored.

The live authoring evaluation uses the installed Codex ACP runtime, the actual
MCP server and authoring API, a disposable database, and fixed provider
catalogs:

```sh
RUN_AGENT_AUTHORING_EVAL=1 pnpm test src/backend/services/session/service/acp/agent-authoring.manual.integration.test.ts
```

It covers the feedback, packet-unlock, and GitHub-label scenarios, a focused
follow-up edit, and ambiguous workspace clarification. Optional
`AGENT_AUTHORING_EVAL_MODEL` selects a model and `AGENT_AUTHORING_EVAL_OUTPUT`
names an existing directory for transcripts/configurations. These are authoring
evaluations, not classifier recall/precision measurements.

### Natural-language event filters

Deterministic matching runs first; only a deterministic match on a trigger with
`filterInstructions` reaches the classifier, so a filter can narrow but never
widen repository, label or channel scope. The session capsule's
`classifyAgentEvent` makes one disposable structured-output call through the
same isolated path as workspace metadata: a temporary directory, no tools, MCP
servers, hooks, settings, repository instructions or saved session, and the
provider process tree cleaned up. It uses each provider's default small model
from `configService.getAgentEventClassifierConfig()` (Claude `haiku`, Codex
`gpt-6-luna`), separate from the automation's execution settings, with a
30-second limit and at most two concurrent calls. Codex calls use the default
account because no run account exists before admission.

The prompt passes the filter and a bounded projection of the event (issue
title/body, repository, label; Slack text and whether it is a thread reply) as
JSON data marked untrusted. For Slack, evaluation reads the trigger's
[message context](#slack-message-context) before calling the classifier, so a
context failure records its error without spending a classifier call, but the
classifier still judges only the triggering message: adding context to the
prompt is a prompt change that needs a new version and gate run. Actor
identities and links are omitted. Event text that asks to be matched has no
authority. The output schema is strict
`{ decision: 'match' | 'skip' | 'uncertain', reason }`; only `match` admits a
run. Evaluations persist `SEMANTIC_FILTER_*` reason codes and fixed
explanations, never the model's reason text. When a classifier call runs, they
also persist its identity (provider, model, prompt version, input hash);
unproven-provider and unavailable skips and too-long errors have none.
`uncertain` and malformed output are terminal; timeouts, rate limits and
provider failures retry on the evaluation budget. A filter longer than 4,000
characters is never sent to a provider and records a terminal
`SEMANTIC_FILTER_TOO_LONG` error.

Evaluation rechecks the gate for the provider resolved for each event, because
an inherited provider can change after Enable. An unproven effective provider
records a `SEMANTIC_FILTER_PROVIDER_UNPROVEN` skip without calling the
classifier.

The gate is a fixture release gate, not a population accuracy claim. Replay
fixtures (GitHub and Slack, with adversarial injection negatives) live in
`src/backend/services/agent-definition/testing/classifier-fixtures.json`, split
into tuning and held-out cases with obvious positives frozen before tuning. A
provider passes on the held-out set with zero adversarial false positives, every
obvious positive matched, positive recall of at least 90% and at most 10% errors
plus `uncertain` decisions. Results per provider are recorded in
`classifier-gate.json` beside the fixtures and mirrored by
`PROVEN_CLASSIFIER_PROVIDERS`, which a test keeps in agreement with the record,
the current prompt version and the configured models. Changing the prompt or a
classifier model requires a new prompt version and a new gate run. The live run
calls real providers and never runs in CI:

```sh
RUN_AGENT_EVENT_CLASSIFIER_EVAL=1 AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER=CLAUDE pnpm test:integration src/backend/services/session/service/acp/agent-event-classifier.manual.integration.test.ts
```

`AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER` is `CLAUDE` or `CODEX`,
`AGENT_EVENT_CLASSIFIER_EVAL_SPLIT=tuning` scores the tuning set instead of the
held-out set, and `AGENT_EVENT_CLASSIFIER_EVAL_OUTPUT` names an existing
directory for a per-case report.

### Slack credentials

Settings > Integrations > Slack accepts an existing Slack Bot User OAuth Token
(`xoxb-` or a rotating `xoxe.xoxb-` access token). Rotating tokens require
manual renewal when they expire; automatic OAuth refresh is not implemented.
Connect Slack validates it against Slack's `auth.test` endpoint, requires a bot
identity and workspace ID, and encrypts the token with the existing AES-256-GCM
encryption service before upserting an `AgentConnection`. Connecting the same
workspace replaces its token without changing the connection ID or trigger
references. Multiple workspaces can be connected.

Slack event intake uses outbound Socket Mode, which needs an app-level token
(`xapp-`, or a rotating `xoxe.xapp-` access token that needs manual renewal;
scope `connections:write`) from the same Slack app as the bot. Each connected
workspace can save one, encrypted in `appCredentialsEncrypted` separately from
the bot token. Saving it first checks the saved bot token with `auth.test` (it
must still identify the connection's workspace), then resolves the bot's app ID
with `bots.info`, which needs the bot's `users:read` scope. The app ID is stored
as `appId`; it is never inferred from the token prefix. The app-level token is
then validated with `apps.connections.open`. Slack's response is only a
single-use Socket Mode URL: it is discarded immediately and never stored,
returned or logged. Slack documents no field that names the token's app, so the
only check is the `app_id` that Slack currently embeds in that URL: a mismatch
rejects the token, and an absent value is accepted. The Socket Mode listener
must still require the `hello` message's `connection_info.app_id` and each
event's `api_app_id` and `team_id` to match the connection. App-level tokens
belong to an app rather than a workspace, so the workspace match comes from the
bot token. A save is discarded if the bot credential changed while it was being
validated. Reconnecting the same workspace with a replacement bot token keeps
the saved app-level token only when `bots.info` confirms the new bot belongs to
the stored app; a different app, or a failed lookup, clears the app-level token
and app ID. Test connection also reports a mismatch between the bot's current
app and the stored app ID.

The trusted-local `slack` tRPC router supports list, connect, test, disconnect,
`setAppToken` and `clearAppToken`. Its summaries expose workspace name/ID,
enabled state, bot and app-level credential presence (`hasCredentials`,
`hasAppToken`) and `appId`; neither plaintext nor encrypted tokens cross read
responses. Summary reads compute credential presence without loading ciphertext.
Only the internal credential lookups load tokens for decryption;
`getAppCredentials(connectionId)` returns the app-level token, app ID and
workspace ID for the Socket Mode listener, or null unless the connection is
enabled with both tokens. Provider responses are Zod-validated, each outbound
call has a ten-second timeout, redirects are rejected, and provider/transport
errors are sanitized rather than echoed. Disconnect clears both tokens and the
app ID and disables the connection while retaining its identity and trigger
references. Removing only the app-level token keeps the bot connection. Neither
revokes tokens in Slack.

The UI masks token entry, keeps it out of browser persistence, and clears it
after a successful save. Existing tokens are never prefilled; replacing an
app-level token opens an empty field. Test connection uses the stored bot token
and verifies its workspace identity; when an app-level token is saved, it also
re-resolves the bot's app and validates the app-level token. No signing secret
is needed. Saving credentials does not enable event subscriptions, change an
existing Slack app's webhook, or start automations.

Slack intake is gated by `AGENT_SLACK_INTAKE_ENABLED`, read through
`configService.getAgentRuntimeLimits().slackIntakeEnabled`. It is off unless set
to exactly `true`, and stays off until a live check against a dedicated Slack
test app passes. While it is off, Slack triggers without an unsupported sender
or natural-language filter report `SLACK_INTAKE_UNAVAILABLE`; Enable refuses
every Slack trigger and creates no pending activation. Behind the gate are the
[Socket Mode listener](#slack-listener) and
[activation by test message](#slack-activation).

These credentials depend on the server's `encryption.key`; retain it with any
database-file backup. Logical export/import includes Slack connection identity,
name, source enabled state and timestamps, but not the app-level token or app
ID. Recovery restores new identities disabled with no tokens; existing
connection IDs or Slack workspace identities are skipped without updates.
Reconnect manually in Slack settings using a new bot token, then add the
app-level token again. GitHub connections, connection bindings, event
configuration and automation execution history remain excluded; tokens and
encryption keys never appear in logical exports.

### Slack listener

The listener holds one outbound Socket Mode connection per eligible Slack
connection, using the official `@slack/socket-mode` client (pinned in
`package.json`) behind a narrow adapter, `SlackEventSource` in the
agent-definition capsule. A connection is eligible only while the intake gate is
on, the connection is enabled with both tokens and an app ID, and at least one
configured Slack trigger on a non-archived project is `STARTING`, or `ACTIVE`
with its trigger and definition enabled, and those triggers select at least one
channel in valid configuration. Nothing is opened otherwise.

The Slack app needs:

- Socket Mode turned on, and an app-level token with `connections:write` saved
  in Settings > Integrations > Slack.
- Event Subscriptions turned on with the bot events `message.channels` (public
  channels, bot scope `channels:history`) and `message.groups` (private
  channels, bot scope `groups:history`). Request URLs are not used.
- Bot scopes `users:read` (to confirm the app when the app-level token is saved)
  and `channels:read`/`groups:read` (channel discovery), and the bot invited to
  every selected channel.
- To be dedicated to this connection. Socket Mode spreads an app's events across
  all of its open connections, so another listener on the same app (or the same
  app connected for a second workspace here) would receive some of the events.
  Two eligible connections with one app ID are both refused with
  `SLACK_APP_SHARED`.

Identity fails closed. The socket's `hello` frame must carry
`connection_info.app_id` equal to the stored app ID, and every `events_api`
envelope must carry the stored `api_app_id` and `team_id`. A mismatch stores
nothing, leaves the envelope unacknowledged, closes the socket and records
source health `ERROR` (`SLACK_APP_MISMATCH` or `SLACK_WORKSPACE_MISMATCH`); the
listener does not reconnect until the stored credentials change or the
application restarts.

Only human messages enter the ledger: `message` events without a bot identity,
both channel roots and thread replies, in a channel selected by a listening
trigger on that connection, either without a subtype or with one of two subtypes
a person's message carries: `file_share` (the message includes a file or
screenshot) and `thread_broadcast` (a thread reply also sent to the channel).
Those two are stored like ordinary messages, text only, with `subtype` recorded;
files and attachments are never stored or fetched, and the starting prompt says
that files were not included. Because files are never included, a `file_share`
whose text is empty or only whitespace (an upload without a comment, in the
channel or a thread) is acknowledged and not stored: it would start a run with
nothing to act on. Every human `thread_broadcast` that passes the checks above
is stored, whatever its text. The deterministic matcher accepts the same three
forms. Each message is stored through `ingestEvent` with identity
`(connectionId, event_id)` and acknowledged only after the insert commits; a
duplicate insert is acknowledged too. If the insert fails, the envelope stays
unacknowledged so Slack can redeliver it. Bot messages (including bot file
shares), hidden messages, edits, deletes, every other subtype, other event
types, messages in unselected channels, malformed messages and non-`events_api`
envelopes are acknowledged and not stored. Text longer than the
100,000-character payload limit is cut with a visible truncation marker. Message
text is never logged.

Source health is `READY` (with `isReady`) once a verified socket says hello. An
unexpected close, a failed or timed-out connection attempt (30 seconds), a
credential change and listener shutdown open a delivery gap `{ from, to: null }`
in the Slack cursor and mark the source `DISCONNECTED` or `ERROR` with a reason
code; the next verified connection closes the gap. A process that exits without
recording its stop leaves `READY` behind; the next start opens a gap from the
last time that listener was known to be connected (`lastObservedAt`, refreshed
about once a minute). When the listener stops on purpose (gate turned off, no
listening trigger left, app-level token missing) it records `DISCONNECTED`
without a gap and closes any open one. The cursor keeps the latest 100 gaps.
Slack may redeliver unacknowledged events, but its documentation says events can
be lost while no connection is open, so a gap means events may have been missed;
nothing recovers them automatically. `RECOVERY_REQUIRED` health is never
overwritten.

The SDK's own reconnection and HTTP retries are turned off: its reconnect path
can reject outside any caller, which is fatal in this backend, and its retries
outlive `disconnect()`. Reconnection is instead the `agent-slack-intake`
reconciliation described in
[background jobs](background-jobs.md#timer-dispatch-ownership), with backoff
from 5 seconds to 5 minutes after failed attempts. A socket that finishes
connecting after the listener closed it is closed again and its events are not
acknowledged. The SDK's logger is replaced with one that drops debug and info
output and reduces warnings and errors to fixed category codes, so tokens,
ticketed socket URLs and message bodies are never logged.

### Slack message context

A Slack trigger's `context` (`includeThread`, default on, and
`nearbyMessageCount`, 0 to 100) decides what conversation the run sees besides
the triggering message. Evaluation reads it once the event has matched
deterministically and its execution settings resolved, before any
natural-language filter, through the `resolveSlackContext` evaluation port. Root
messages with only `includeThread` and replies with neither option need no Slack
call.

- With `includeThread`, a thread reply (including a `thread_broadcast`) reads
  its thread with `conversations.replies`: the thread start and the replies
  before the triggering message, oldest first, following cursors for at most
  five pages of 200 replies.
- With `nearbyMessageCount`, the channel's messages just before the triggering
  message are read with `conversations.history` (newest first, paging until the
  count is met, at most five pages), skipping messages already in the thread.
- Only the triggering message's channel is read, and only when the trigger
  selects it; nothing after the triggering message is read. Joins, topic
  changes, edits and other system messages are not context. Bot messages are,
  labelled as bot.

Both reads use the connection's bot token through the internal credential lookup
and `callSlackApi` (ten-second limit combined with the evaluation's abort
signal, no redirects, Zod-validated pages, sanitized errors). The token never
reaches logs, errors, evaluations, run snapshots or the event ledger, and the
connection must still belong to the event's workspace. The scopes are the
listener's history scopes: `channels:history` for public channels and
`groups:history` for private channels, with the bot in the channel. Slack lists
both methods as Tier 3 for internal apps; Slack's May 2025 limits for
commercially distributed non-Marketplace apps (one request a minute, 15
messages) would make context reads fail as rate limited.

Context is capped at 100 messages and 100,000 characters in total. The budget
goes nearest the triggering message first: the thread start, then replies newest
first, then channel messages newest first. Each section drops only its oldest
messages and says so in a marker such as
`[51 earlier replies omitted: Slack context is capped at 100 messages and 100,000 characters.]`.
A message longer than 10,000 characters is shortened with `[message shortened]`,
and a thread longer than the page limit ends with a marker saying later replies
were not read.

The run input lists, in order: a `<eventId>:source` item naming the triggering
message (channel, author, time, thread, files not included, link) and saying its
text follows; `<eventId>:message`, the message text; `<eventId>:thread`, the
thread section; and `<eventId>:channel`, the channel section. Each section
starts by saying it is context only, not the request, then gives each message as
`Reply from person U123 at <time>:` (or `Thread start from`, `From`, `bot`, and
`(files not included)`) followed by its text with every line quoted with `> `,
so context text cannot pose as a label or as the triggering message. The
starting prompt already calls all of it task data, not authority.

Failures never start a run with partial context. Rate limits (honoring
`Retry-After`), unreachable Slack and Slack server errors record a retryable
`ERROR` (`SLACK_CONTEXT_RATE_LIMITED` or `SLACK_CONTEXT_RETRY`) on the shared
evaluation retry budget. A missing history scope (`SLACK_CONTEXT_MISSING_SCOPE`,
naming both scopes), a channel or thread the bot cannot read
(`SLACK_CONTEXT_CHANNEL_UNAVAILABLE`), a missing, rejected or other-workspace
bot token (`SLACK_CONTEXT_NOT_CONNECTED`), an unexpected Slack response
(`SLACK_CONTEXT_FAILED`), an unselected channel (`SLACK_CONTEXT_NOT_SELECTED`)
or an unwired port (`SLACK_CONTEXT_UNAVAILABLE`) is a terminal `ERROR`.

### Slack activation

A Slack trigger has no provider feed to take a baseline from, so it starts from
a test message the user posts in each selected channel. The message proves that
Slack delivers that channel's messages to this app, and its provider timestamp
becomes that channel's activation boundary.

To turn on a Slack automation:

1. Set up the Slack app as described under [Slack listener](#slack-listener),
   connect the workspace and save its app-level token in Settings >
   Integrations > Slack, and invite the bot to every channel the automation
   selects.
2. With intake switched on, select Enable on the automation. Its Slack trigger
   reads Starting, first "Connecting…", then "Connected; waiting for test
   message" once the listener is connected (within about 15 seconds).
3. Copy the message the trigger shows, for example
   `Factory Factory check 7kq2-m9xh-c4tr`, and post it as an ordinary message
   (not a thread reply, not with a file) in each listed channel within ten
   minutes. The next evaluation pass, usually within five seconds, records each
   channel's message, and the detail shows it as Received at its next refresh,
   typically within about 15 seconds. The trigger reads Listening once every
   channel has it.
4. If the ten minutes pass first, the trigger returns to Paused
   (`ACTIVATION_EXPIRED`); select Enable again for a new message.

Enable runs the shared validation: a Slack trigger is supported only while
intake is on, its connection is enabled with both tokens and an app ID
(`SLACK_APP_TOKEN_REQUIRED` otherwise), its channels are still readable by the
bot (`SOURCE_UNAVAILABLE` otherwise), and it has no sender filter
(`UNSUPPORTED_ACTOR_FILTER`). Enable then stores the pending activation on a new
generation before the listener can open for it: a code of twelve characters from
a 31-character alphabet without look-alikes (about 59 bits), the expected
workspace and app IDs, the selected channels with the names validation resolved,
the definition and trigger revisions, and a ten-minute expiry
(`slackActivationExpiryMs`). The code proves delivery, not identity; it is safe
to post and grants nothing. Reads expose it as `pendingVerification`
(`{ message, expiresAt, channels: { channelId, name, verified }[] }`) while the
trigger is `STARTING`; the detail refreshes every 10 seconds.

The listener stores test messages like any other message. The
`agent-event-evaluation` job completes Slack activations at the start of each
pass, in a ledger transaction per generation. A stored event verifies a channel
only when it is on the expected connection, workspace and app, from a person
(`actorType` `HUMAN`) with no subtype and no thread (a root message), in a
pending channel of this generation, observed by the listener no later than the
expiry, and its whole text, ignoring case and surrounding or repeated spaces, is
`Factory Factory check <code>` for this generation's code. The earliest such
message in a channel (by exact provider timestamp) is its boundary. When every
channel is verified, the same transaction rechecks the definition and trigger
revisions, validated intent, membership, project and connection identity and
activates the trigger with the Slack boundary
`{ workspaceId, appId, channels: { channelId, eventTs }[] }`. An edit, Pause or
source change in the meantime leaves it `PAUSED` instead; a changed app or
disabled connection records `SOURCE_ERROR`. A generation still unverified at its
expiry returns to `PAUSED` with `ACTIVATION_EXPIRED`; a message observed after
the expiry never counts, even if completion runs later. Re-enabling always
creates a new generation with a new code, so an earlier test message cannot
activate it, and messages from the paused period stay before the new boundaries.
Enable also restarts an active Slack trigger whose boundary names a different
workspace or app than the one just validated, since events from the new app
would fail its identity check.

Messages that arrive while a trigger is `STARTING` are held: evaluation skips
`STARTING` triggers and records nothing for them. Once the trigger is active,
the next evaluation pass evaluates them against their channel's boundary, so a
message posted after channel A was verified, while channel B was still pending,
runs; one in B before B's test message is `BEFORE_ACTIVATION`. Boundaries
compare Slack `ts` strings exactly as decimals (whole seconds as integers, then
the fraction digit by digit), never as floats, local clocks or `observedAt`. A
test message sits at its own channel's boundary, so it is never after it. If the
generation expires or is paused instead, the held messages are evaluated against
the paused trigger and settle as `SKIPPED` (`TRIGGER_DISABLED`). A message whose
whole text has the test-message form never runs: for any Slack trigger that
selects its channel and is past that channel's boundary, it is skipped as
`VERIFICATION_MESSAGE` (otherwise it is skipped earlier, for example as
`BEFORE_ACTIVATION`). Posting one in a channel another automation already
listens to therefore starts no run and costs no Slack history read.

### End-to-end checks

The `src/backend/testing/agent-runtime-flow.integration.test.ts` and
`agent-runtime-flow-launch.integration.test.ts` suites drive a saved GitHub
automation through `automation.enable`, the runtime's registered jobs (source
poll, evaluation, launch maintenance) and the history reads, with fake GitHub,
Git, classifier and provider transport. They cover `labeled` and `reopened`
runs, events before Enable and while paused, filter outcomes, pause racing a
claim, an edit while `STARTING`, Reset source, Delete, child-workspace
settlement and its 24-hour deadline, duplicate delivery, restarts at the launch
boundaries, and an uncertain send.
`src/backend/orchestration/testing/agent-runtime-flow.test-support.ts` composes
the runtime as `app-context.ts` does.

An opt-in live check reads a real repository's issue-events feed through
`GitHubCLIService` with the local `gh` login and validates the parser against
every row of the first three pages, requiring at least one labeled or reopened
event. It creates nothing on GitHub and is never run in CI; use a throwaway
repository with some labeled and reopened issues:

```sh
AGENT_LIVE_GITHUB_REPO=owner/name pnpm test:integration src/backend/services/github/service/github-cli-agent-issue-events.manual.integration.test.ts
```

### Current event automation limits

- GitHub triggers run on `labeled` and `reopened` issue events, read by polling
  about once a minute. `opened` and `edited` can be saved but not enabled
  (`UNSUPPORTED_GITHUB_ACTION`); pull request, comment, review and CI events are
  not triggers. See the
  [webhook intake proposal](../design/github-webhook-intake.md).
- Actor filters (`creatorIds`, `senderIds`) are rejected
  (`UNSUPPORTED_ACTOR_FILTER`).
- Schedule triggers stay with [scheduled automations](#scheduled-automations)
  (`PeriodicTask`); event evaluation never runs them.
- A natural-language filter's classifier judges only the triggering event's own
  text (issue title and body, or the Slack message), not thread or channel
  context.
- Logical export/import restores definition bodies paused and Slack connection
  identities without tokens, but omits GitHub connections, event configuration,
  activation and run/event history; the complete backup is the database file
  with `encryption.key`.
- Slack intake is off by default: Slack triggers can be enabled only with
  `AGENT_SLACK_INTAKE_ENABLED=true`. Keep it unset until the live check against
  a dedicated Slack app passes.
- Runs never reply on the source issue or Slack thread.

## Client query transport

The browser streams completed tRPC queries within each HTTP batch so a slow read
does not hold up independent results. Mutations retain ordinary HTTP batching,
including support for response headers and cookies. Both transports use the same
relative `/api/trpc` URL, default same-origin credentials and SuperJSON.

The Express adapter and authenticated HTTP proxy pass incremental query chunks
through. An external proxy configured to buffer responses can still delay
results until the batch finishes; disable response buffering for `/api/trpc`
when configuring such a proxy. Procedure errors remain independent within a
batch.

## Held for other guides

Rules, hazards and reasons from the migrated sections that belong to another
area. Each entry quotes only the sentences it needs from the paragraph named
after it, verbatim, with `[…]` where sentences between them are left out. The
migration that creates the named area's guide checks the entry, moves what holds
there and deletes the entry here. Paragraph numbers are the rows of the
disposition table in pull request #3238.

> Coordination is in-process and uses lexically resolved paths; filesystem
> aliases such as symlinks to the same directory are not coordinated.

Old paragraph 5. For the workspace capsule (`src/backend/services/workspace/`):
the guide of the directory that owns cloning.

> Default sessions use the `periodic-task` workflow, so non-interactive Codex
> startup selects unattended execution mode and tool approval prompts cannot
> stall scheduled runs.

Old paragraph 27. For the session capsule guide.
