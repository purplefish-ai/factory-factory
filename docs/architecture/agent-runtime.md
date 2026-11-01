# Agent Runtime

Rejected or failed messages restore their text and attachments only when the
current session composer is empty. A newer draft or attachment selection is
preserved, and clearing it later does not replay the earlier recovery.

Chat drafts restored before the composer mounts are visible on its first render
and retained when typing begins after a reload.

Claude session history restores inline image blocks as attachments on the
original user prompt, including image-only prompts. Harness metadata, sidechain
entries, `/compact` summaries, and image-reference companions are omitted from
chat replay; their temporary file paths are not read. Codex history likewise
restores user `input_image` data URLs, and images on legacy `user_message`
events, onto the prompt; non-user images and `local_images` paths are skipped.
Restoration rejects malformed base64 and images above the shared 10 MiB decoded
size limit used for uploads.

Upload validation checks the complete JPEG codestream through its end-of-image
marker and permits trailing metadata, including Samsung screenshot capture
information. Truncated image segments and scans remain invalid.

The new-workspace slash-command palette prefers project command descriptions
over same-named global commands, matching the workspace-first precedence used
when loading a Claude session. Commands found only in the global directory
remain available. Claude provider caches exclude `project:` and `workspace:`
commands, including nested names, regardless of disk-scan availability. Passive
loads also reject scoped entries left in an older global cache.

Workspace notification recovery ignores provisional user transcript entries
while their provider dispatch is unsettled, including across session stop/reset.
Only settled transcript evidence can acknowledge delivery; a failed send leaves
its durable notification pending for a later startup to recover.

Child workspace creation offers active projects only and rejects archived target
projects at the orchestration boundary, including requests from MCP clients or
stale browser selections. Child inserts also connect only to active projects
inside their nested-write transaction, so concurrent archival cannot bypass the
preflight check. Existing children of archived projects remain visible.

Closing a provider-backed session requires retained provider messages or a
confirmed JSONL history load, including a confirmed empty history. Unavailable
history and hydration cooldowns abort archival and preserve the live session for
retry; local lifecycle and failed PR status cards do not prove the conversation
was recovered. A runtime observed creating a new provider conversation may
archive it before its first prompt even if no JSONL file exists. This proof is
scoped to the exact provider identity, survives a normal stop, and is revoked
before any prompt attempt, on conversation activity, identity replacement,
failed startup, permanent deletion, or shutdown. It is not inferred after a
backend restart; an unprompted session without a file then remains protected
until provider history can be confirmed. Empty ACP fallbacks remain eligible for
a JSONL read.

## ACP runtime

All agent sessions use Agent Client Protocol over stdio JSON-RPC through
`@agentclientprotocol/sdk` 2.1.0 through its v1 `/unstable` entrypoint. Typed
client app handlers preserve elicitation and native subagent features;
`acp-connection.ts` owns SDK registration and peer-context calls. Claude uses
`claude-agent-acp` 0.99.1 and Codex uses the released
`@agentclientprotocol/codex-acp` 2.5.0. Factory Factory does not implement a
Codex harness adapter. Codex's compatible runtime is packaged with its adapter;
`ff codex login` authenticates that same runtime. Claude also ships its native
runtime through the adapter's matched Agent SDK. `ff claude` delegates to the
adapter's `--cli` passthrough, and `ff claude auth login` authenticates it.
Health checks inspect these managed runtimes, never global provider CLIs. Setup
terminal sign-in actions launch these commands directly in a PTY; they do not
require `ff` or Node on PATH. Replacing the shell with a login process ignores
output/exit events from the replaced PTY and tags login exits with their
provider so an earlier shell exit cannot finish a pending login. It restores a
shell when login exits. Login actions stay disabled while authentication is
active, and server errors are shown in terminal output; ordinary shell exits
stay stopped. Both runtimes update with Factory Factory releases; legacy
global-upgrade requests are rejected. `CLAUDE_CODE_EXECUTABLE` remains an
explicit upstream override and is inherited by both Claude sessions and managed
CLI operations.

On Unix, the `ff claude` and `ff codex` passthroughs forward terminal resizes.
Both passthroughs bound process-tree shutdown after interrupts or abnormal
provider CLI exits. Cleanup failures are logged without replacing the provider's
exit status. Successful commands retain the native CLI's background-job
behavior. Desktop sign-in guidance uses the setup terminal buttons; typed `ff`
commands require the CLI to be installed.

Adapter entrypoints run with the host Node runtime, including Electron's bundled
Node (see [desktop backend process](#desktop-backend-process)), and are unpacked
in desktop packages along with their complete production dependency trees. The
desktop release smoke check runs bundled Claude and its actual ACP catalog
loader with an empty PATH; CI may require authentication before returning model
choices. Authentication-only validation requires the explicit
`--allow-unauthenticated` smoke flag and reports that the catalog was not
verified when that fallback is used. Model discovery uses the same bundled Codex
runtime, without starting an inference turn. Claude model discovery uses an
ephemeral ACP session with tools disabled. Both catalog services coalesce
requests and cache successful results for 30 seconds.

Session startup validates that the workspace working directory exists and is a
directory before spawning an adapter. Missing worktrees report the affected path
and require restoring the worktree before retrying. Node otherwise reports a
misleading `spawn <node> ENOENT` when the working directory is missing, even if
the Node executable exists.

Failed exact-conversation resumes retain the provider's diagnostic details and
original error so missing Codex rollout history is actionable instead of
appearing only as `Internal error`.

Provider-native configuration controls own access permissions. Codex `mode`
selects access and `collaboration_mode` selects planning independently. Claude
`mode` owns its native access/planning modes. Saved STRICT/RELAXED/YOLO defaults
remain backward-compatible preset inputs, mapped to advertised native values
that match the adapters' standard, auto-review, and full-access mode kinds.
RELAXED selects Codex `agent` and Claude `auto`. Claude uses `acceptEdits` when
Auto mode is unavailable: the adapter applies it for models without Auto, and
startup selects it when `auto` is not advertised. Startup and saved-mode
restoration accept this fallback. The ACP client never automatically grants a
permission because of a preset. Read-only review sessions use the provider's
read-only/plan mode and reject all permission escalation. Access modes,
including Claude planning, use `session/set_mode`. Models and other settings,
including Codex collaboration, use `session/set_config_option`; legacy
model/mode response fallbacks remain supported. Boolean options remain in
backend snapshots while current chat controls render select options.

The conversation composer keeps the model visible and shows reasoning effort
when supported by native configuration or resolved capabilities. Access,
planning, Fast mode, and Ultracode use compact icons with the current value in a
tooltip and accessible label. Planning and provider settings advertising On/Off
choices toggle directly without opening a menu, with their state exposed through
`aria-pressed`. ACP supplies their current values and choices; descriptions are
shown when provider-supplied. Ultracode uses a sparkle icon. Active toggles are
highlighted; unrestricted access uses an orange warning icon. Native effort
options replace the legacy thinking/reasoning controls, and a native mode menu
offering Plan replaces the legacy planning toggle. Menus show provider-supplied
descriptions for settings and choices. On mobile, the options sheet retains text
labels.

### Provider and model selection

Each default application graph constructs its own session creation resolver and
data facade. Their forwarding callbacks use the graph's current workspace,
resolver, and `userSettingsQueryService` capabilities for persisted provider and
model defaults. The separate `userSettingsService` alias still serves PR/bridge
policy; substituting settings for both policies requires binding both aliases.
The session capsule also exports factories for explicit construction and retains
process-default singleton exports for legacy callers. Persistence accessors,
acquisition queues, and other runtime settings reads retain their existing
scope; this creation boundary does not isolate an entire application runtime or
make separate settings reads atomic.

Model selection uses the explicit launch choice, then the user's saved default
for that provider. Existing conversations retain their stored model. New and
resumed runtimes apply that model through the advertised ACP model option before
publishing ready configuration or accepting prompts. Unsupported choices fail
explicitly; they never silently select the first model. Codex's saved `default`
means its native default, and supported Claude family aliases resolve to the
advertised identity. Browse-only restoration does not change configuration.
Startup model configuration shares the bounded startup deadline and cancellation
signals. Passive catalog reads enrich available options without persisting a
guessed selection or overwriting a newer runtime/edit. Catalog-only chat
projections do not select a reasoning effort. Before native configuration is
available, the chat bar withholds the effort control rather than briefly
displaying the catalog default or first supported level.

Client settings remain intact while capabilities are unknown. Initial confirmed
configuration supersedes bootstrap model values; explicit edits and restored
reasoning/planning settings survive hydration. Configuration from a previous
session visit cannot update the newly selected conversation. A message submitted
before configuration arrives relies on the server's stored selection instead of
sending a hardcoded client model. Pending model choices stay visible until
confirmed. Rejected or unsent changes restore the confirmed model; request
correlation prevents an older rejection from discarding a newer choice. Each
conversation restores its own draft and attachments, including switches before
draft autosave completes. Chat configuration controls remain editable during a
turn. Edits retain a visible pending selection and apply after that prompt
settles, before the next prompt can start; background activity alone does not
delay them. Newer explicit edits supersede the corresponding settings in
messages already queued for that session, including across runtime restarts;
newer queued intent remains intact. Request acknowledgments and correlated
failures settle only the matching pending choice, so an older response cannot
discard a newer edit. Stopping or replacing the runtime rejects its deferred
edits. Disconnecting clears unacknowledged selections so reconnect snapshots
regain authority. Model/configuration writes serialize per session through
persistence and state publication, including failure corrections; different
sessions remain independent. Accepted native observations, successful RPC
results, and startup snapshots share a configuration authority fence through
metadata reads, CAS retries, and publication. Failed requests leave the last
accepted state valid; superseded background writes stop without publishing a
stale result. Public snapshot persistence exhaustion propagates an error and
configuration correction; native asynchronous observations own their background
rejection and logging. The
[startup finalizer](#permission-and-configuration-readiness) owns startup
durability, permission checks, readiness, and failure cleanup. Later genuine
server changes remain authoritative after pending edits settle. Model-only
changes preserve a supported explicit reasoning effort; an unsupported effort
normalizes to the new model's confirmed default. Each session load has a
10-second UI loading safety timer, including creation from an empty Quick Chat.
This UI timer does not release backend configuration readiness.

### Launch permissions, thinking, and Plan

Manual workspace creation offers the provider/model picker and compact thinking
menus, an Access icon, and a planning toggle styled like the chat configuration
controls. Access offers the selected provider/model’s native permission choices
and starts from the saved workspace permission preset. Explicit access choices
are retained per provider and confirmed before the first prompt. Claude Plan
takes precedence over the launch access choice while enabled. Planning switches
directly between Default and Plan; unsupported selected Plan can still be
cleared. New conversations in an existing workspace (the workspace tab bar,
Quick Chat, and quick actions) have no launch pickers: they reuse the provider
and model of the workspace's oldest session, or the workspace provider and saved
model default when it has none, and omit thinking and Plan so the saved thinking
default applies with Plan off. Users change these per conversation from the
composer. Thinking levels and planning availability come from a disposable ACP
session configured with the selected provider/model; the provider-wide model
catalog is not used as a thinking capability list. Discovery submits no prompt,
rejects permission/tool callbacks, and closes its processes. Its endpoint
requires the trusted-local boundary used for local execution. Successful native
results are cached for 30 seconds per provider/model, with bounded cache and
concurrent discovery counts. Failed discovery offers Retry; creation waits for
confirmed options while model selection remains editable.

Each launch draft snapshots its saved provider defaults and retains explicit
thinking/Plan choices across provider switches and settings refreshes. A model
change that makes an explicit level unavailable keeps that choice visible and
blocks creation until a supported level or Default is selected. Unsupported
inherited thinking preferences use the native default instead. An unavailable
saved permission preset requires an explicit choice from Access before launch;
launch never silently replaces that preset with a potentially broader native
default. Unavailable access choices show a warning and a disabled menu entry.
Manual launch validates explicit access against discovered provider/model modes
before workspace persistence; startup confirms the selected mode again before
accepting a prompt. Existing chat navigation and periodic-task creation do not
depend on launch-option readiness.

Launch requests distinguish an omitted `reasoningEffort` (saved provider
default), explicit null (native default), and a supported value (that exact
level). The UI submits its displayed resolved choice. Validated
`providerMetadata.launchSettings` stores initial intent with `applied: false`;
only the startup owner's final confirmed snapshot marks it applied. Intermediate
configuration snapshots cannot consume it. Startup refreshes durable intent
after context and runtime handoff. A conditional repository acknowledgment
compares the model/thinking/Plan actually applied with current desired fields at
its CAS boundary. Changed intent is reread and reapplied. Observed snapshots
cannot rewrite desired launch fields; only explicit stopped edits own those
patches. Per-start thinking/Plan overrides retain precedence and may leave
conflicting stored choices unconsumed. Explicit model selection keeps its
confirmed model column persistence semantics. Identity-matched confirmed
snapshots own later resumes, including edits made after launch and changes to
global defaults. A saved level no longer supported after a model change uses the
new model's native default; unsupported explicit launch levels fail before
prompts. Stopped-session edits require a durable snapshot write and report
persistence errors. Applied launch intent with a missing or invalid snapshot
stops resume instead of replacing confirmed choices with global defaults.

Plan-on selects Claude's native plan access mode or Codex's plan collaboration
mode. Plan-off retains the configured permission preset rather than applying a
legacy permissive execution preset. Explicit native failures or unconfirmed
settings stop startup before readiness and first dispatch. Existing reviewer
restrictions and browse-only restoration remain authoritative.

Queued message settings have a separate null meaning: no effort override. This
preserves confirmed startup thinking through the first automatic workspace
prompt and messages composed before capabilities load. Explicit queued thinking
values still apply before their prompt.

### Permission and configuration readiness

Tool permission prompts keep request content above the approval actions so long
provider option labels cannot squeeze the request. Tool previews preserve
literal text, line breaks, and indentation in a bounded, keyboard-scrollable
monospace panel; long lines scroll horizontally. Consent messages retain prose
formatting.

Permission defaults initialize new sessions. Existing sessions restore their
saved native access and Codex planning choices before publishing a new snapshot
or dispatching work. Prompts and user configuration changes wait for that
restoration on the current runtime handle. Invalid, mismatched, or unavailable
saved modes stop startup; legacy sessions without a snapshot retain the
configured-default fallback. Reviewer workflows always reapply their read-only
restrictions. An explicitly requested Claude plan preset authorizes its
confirmed native plan access; Codex planning changes its separate collaboration
control and retains the required access mode. Optional preset failures warn and
continue only while the current access still satisfies the authorized target.

The config-owned startup finalizer persists the current accepted snapshot
outside the public readiness queue. Snapshot storage owns metadata merging,
guarded CAS writes, and retry; it does not decide startup readiness. If native
configuration supersedes the final startup write, startup recaptures and
persists the current handle before opening readiness. The final durable intent
read precedes the last async request/lifecycle check; authority and required
permissions are then checked synchronously with actual readiness completion. A
changed required access mode fails startup, including observations during
permission RPC or persistence continuations.

A mandatory current configuration failure permanently rejects the candidate's
readiness and attempts to stop only that runtime incarnation, including a shared
candidate. Runtime identity and lifecycle generation fences preserve
replacements and newer stops. Caller-specific cancellation retains shared
cleanup protections: a healthy shared candidate's completion owner continues
under independent runtime/lifecycle guards, opens readiness for surviving users,
then rejects the cancelled request before its prompt. Native snapshot failures
after readiness remain best effort; their asynchronous owner catches and logs
rejection.

Configuration readiness intentionally has no independent timeout. If provider
setup stalls, prompts and settings remain blocked until setup fails, the child
exits, or the session is stopped; elapsed time never releases work with unknown
permissions.

Persisted ACP configuration snapshots are validated before use. Legacy Codex
collaboration/access tuples are converted into native options before startup,
inactive-session display, or strict PR continuation. Durable legacy `sess_`
provider identities remain unchanged; transport calls use the underlying native
Codex thread ID. A failed legacy resume cannot start a replacement conversation.
History loading accepts both legacy event messages and current public response
items, deduplicates copies per turn, and excludes injected context and internal
reasoning; rollouts without content-kind metadata drop user messages before the
first prompt that are only `<environment_context>` or `<user_instructions>`,
while later tag-only messages are kept as typed. Active and browse resumes
hydrate on-disk history before starting the ACP runtime, preserving original
message timestamps and suppressing duplicate adapter replay. Concurrent startups
share history preparation; joining a runtime already starting preserves its
replay policy. Without on-disk history or a retained provider transcript, ACP
replay remains the fallback; each replayed user message closes the open reply
and gets its own transcript row. Terminal output deltas are negotiated
explicitly, accumulated with per-tool and total pending-tool limits, and
included in completed tool results. Buffers are isolated by session and cleared
on teardown.

For tracked tool calls, object-valued ACP `rawInput` refinements replace the
existing card's input, preserving its original order and tool name through live
updates and reconnects. Status-only updates and invalid inputs leave the input
intact.

Permission requests retain the provider's option IDs and choices. When requests
overlap, the newest is shown; answering or cancelling it shows the newest
request still awaiting a response, including on reconnect. Upstream Codex plan
review and Claude's AIR `Approve Plan` requests with plan text are normalized
into the application's plan UI, including pending requests restored on
reconnect. Approval clears the composer's plan mode. Interactive sessions wait
for a user response; read-only reviewers automatically reject plan
implementation. Both adapters own their plan implementation continuation; the
client does not enqueue a second approval turn. Structured questions use ACP
form elicitation, with validated answers mapped into the existing question UI.
Numeric fields display validation errors before submission, and blank enum
choices retain their exact provider values behind visible labels. String
patterns use bounded RE2 compilation and linear-time matching in the browser and
backend; unsupported expressions fail closed. Run `pnpm test:acp:manual` for the
live handshake or `pnpm test:acp:manual:prompt` to explicitly enable a read-only
model round trip. URL elicitation exposes the destination and message and
requires explicit consent; it never opens a URL automatically. Cancellation
resolves pending permissions and elicitations as cancelled and dismisses their
prompts.

Native subagent/session updates are captured before SDK validation because the
subagent contract is still a draft. Children retain separate transcripts and
permissions remain routed through the owning parent. Child tool calls also reach
interceptors that opt in to sub-agent events, such as PR detection. The client
negotiates upstream background-task metadata and combines subagent, goal and
task activity so provider work outside a prompt keeps the session running.
History replay reconstructs child transcripts without publishing background
activity or forwarding historical child tool calls to interceptors. Replay
completion clears unverified tasks and goals and marks unfinished replayed
children interrupted; recovered terminal child states remain intact. Codex shell
tasks survive because the adapter verifies them against its live terminal
listing. Claude's negotiated `loadReplayEnd` marker ends this window before any
subsequent live updates; providers without that marker use the load response.
Transcript replay suppression lifts only for an in-flight prompt, never solely
because background activity exists. Native session loading reconstructs child
histories; no Factory Factory extension is required from either adapter. Each
child's in-memory transcript retains at most 100 turns and 2 MiB of serialized
updates. Oldest whole turns are evicted; an oversized active turn is discarded
until the next user turn. Cursors use monotonic turn offsets, and expired
cursors fail explicitly instead of returning another turn. Codex resumes of the
same child thread share one list entry and transcript, including across provider
generation IDs. Each generation starts a pagination turn; completion of an older
generation cannot stop a resumed child. Stale parent generations cannot start
new child or background work, but may settle work they previously spawned. Child
`updated` notifications are throttled to one per subagent every 250 ms because
each one makes viewers refetch the list or transcript; `created` and `completed`
are sent immediately. Viewers run one refetch at a time and queue a single
follow-up when changes arrive mid-flight, so the final update is never missed.

ACP negotiates structured session failures. A prompt response carrying an error
in `_meta.jetbrains.air.sessionFailure` fails the turn through the normal
provider-error lifecycle path, regardless of its stop reason, clearing its
working indicator and recording a `TURN_INTERRUPTED` event. The error remains on
the session until the next prompt starts, across runtime reads and background
activity updates. The known model-capacity message retains its
retry/model-switch guidance; other provider errors use the existing
public-message sanitization. Warning notices render as chat messages, including
during idle session resume, without lifting transcript replay suppression. Each
notice ID/revision is shown once per session runtime. Warnings and cleared
failures do not fail a turn.

### Activity and prompt dispatch

Workspace/session activity and ownership of a conversation's prompt slot are
separate signals. `isSessionWorking` includes in-flight prompts, background
agent turns and tasks, native subagents and active goals. Background shell
commands (including persistent preview servers) remain visible but do not keep
the session or workspace working after the prompt completes. The work signal
drives runtime activity, the yellow work indicator and the workspace column.
`isSessionPromptInFlight` answers only whether the current active runtime has an
unresolved prompt RPC. Browse-only runtimes do not own an active prompt slot.

Runtime snapshots also carry prompt ownership and named background tasks, with
counts for running subagents and active goals. A transition that changes only
the runtime timestamp refreshes the stored state without publishing a delta, so
repeated task notifications do not trigger workspace summary refreshes. The
event collector remembers each session's workspace (sharing one lookup while it
is first resolved). Session-summary and pending-request refreshes each run at
most one query per workspace at a time plus one trailing rerun, so a burst of
one kind of event costs two queries instead of one per event. Thought chunks are
merged per 25 ms window like assistant text. They are flushed before the next
translated update, replayed user message, runtime event, turn boundary or
provider identity rollover, so transcript order is unchanged. Permission
prompts, which show outside the transcript, do not wait for them. Chat shows
background processes separately from the active-turn spinner, with a
process-count header that expands to show their commands. The command list
starts collapsed. Live status announcements contain the process count separately
from the control and commands. A completed turn with a persistent preview server
shows the remaining process instead of stale reasoning or “Agent is working”.
Task-detail changes publish even while another task keeps the session busy, and
reconnects restore current work from the live runtime. Idle and error
transitions discard cached work unless fresh details are explicitly supplied;
stopped transitions always clear work. A failed turn retains fresh background
details from the live runtime, and chat keeps those processes visible alongside
the error state.

Ordinary chat messages may be composed and queued during any turn. Dispatch
waits for the preceding prompt to complete, including time spent executing tools
or awaiting that turn's approval, question or elicitation. A background shell,
independently running child or active goal does not block the next parent prompt
once that RPC completes. The provider remains authoritative: if it reports an
active turn that the client cannot observe, the existing bounded busy retry
preserves the queued message, and the running turn keeps its tool-call tracking
for interceptors such as PR detection.

Queued human messages also offer an explicit **Steer** action during an active
prompt. Normal sends still queue. Steer submits only that message through the
adapter's advertised `_session/steering` extension, preserving attachments and
the active turn's configuration. Slash commands and automatic notifications
remain queued. Concurrent steering of a different message reports a busy error;
repeated clicks on the same pending message coalesce. If there is no active
turn, a stale click on a later message is rejected instead of dispatching an
earlier queue entry. Failed steering leaves the message queued. A steering
acknowledgment has a 10-second deadline. On timeout, the client terminates that
runtime before releasing queue ownership and withholds immediate automatic
resend. Input may have been consumed before the missing acknowledgment, so a
later explicit retry may repeat prior effects. The host requests
`idleBehavior: "promptRequired"`, so a completion race falls back to ordinary
prompt dispatch instead of creating an untracked adapter-owned turn. Accepted
input is removed from the queue even if stopping advances the generation while
the request settles, preventing a delivered steer from being replayed on resume.

Codex uses native `turn/steer` without cancelling the current turn. Claude's
native steering may pre-empt generation or background a foreground tool; neither
provider promises delivery at a specific tool boundary. The action tooltip
explains that active work may be redirected.

The workspace and quick-chat composers use prompt ownership for their queue
placeholder and send-button label; background activity keeps the stop control
available for active agent work without implying that the next message must
wait.

Startup and required configuration must complete before submission. Workspace
initialization/manual-resume policy, compaction, per-session dispatch
serialization and stop/generation fences still apply. The prompt slot is
rechecked after auto-start; another caller may have acquired it while startup
was awaited. A stopped runtime can auto-resume through the existing launch
policy; being stopped is not permission to bypass setup or a failed exact
resume.

Automatic PR updates additionally wait for pending interactive requests, an
in-flight prompt in another conversation in the same workspace, valid recipient
and binding checks, and an unpaused delivery policy. Background activity alone
does not block delivery in either the recipient or another conversation. Receipt
recovery waits for the actual prompt or the specific delivery attempt, not
unrelated background work. Other conversations' prompts do not prevent a human
from sending to their selected conversation.

Factory Factory supplies workspace MCP servers through session-scoped adapter
configuration. It never writes the user's native Codex configuration. Requested
workspace MCP configuration takes precedence over stale entries left by older
Factory Factory versions; native configuration for other servers is retained.

Session stop history is durable: `SessionLifecycleEvent` rows are append-only,
deduplicated by session/attempt key, and rendered as structured chat rows after
reconnect or restart. Provider history keeps its transcript order; each card
follows the last provider message timestamped at or before it. Normal user turns
have a four-hour deadline. Startup/stop incarnation fences protect runtime
replacement and shutdown.

Provider protocol schemas are maintained by upstream adapters. Keep focused ACP
client contract tests when upgrading either dependency, including saved-session
resume, plan approval, questions, native subagents, and reviewer permissions.

### Codex accounts

The composer previews only the model name; provider groups remain in the
selection menu. Account labels are omitted from composer controls.

Settings → Codex accounts supports one or many native ChatGPT accounts. The
Native default entry preserves the existing Codex home and inherited
configuration. Add Codex account creates a separate private profile under FF's
application data directory; its credentials are stored by Codex itself, outside
repositories. Settings, plugins, skills and memory are separate for each added
account, while repository configuration still applies.

Managed profiles inherit missing project trust decisions from the Native default
Codex home's `config.toml` whenever prepared for use, including after a stop and
resume. Explicit managed-profile project entries take precedence. Only project
trust levels are inherited; credentials and other account settings stay
isolated. This lets linked worktrees load repository-local Codex configuration
without requiring the same repository to be trusted again for every ChatGPT
account. Initial account creation only prepares private storage; trust
inheritance is deferred until use so an inheritance failure does not report a
persisted account as a failed creation.

Account management and plan usage are restricted to trusted local clients.
Sign-in uses Codex's native browser OAuth flow. Only one browser login runs at a
time because the native callback uses a fixed localhost port. The dialog
provides the native authorization link, pending/result states and cancellation.
Device-code sign-in requires an additional account setting and is not the
default flow.

New Codex conversations offer Auto or a named account. Auto filters signed-out,
identity-mismatched, disabled and incompatible model/effort profiles, excludes
known exhausted quota windows, and compares relevant usage pressure. Unknown
quota is not treated as unused quota. Concurrent creation reserves candidates
and uses recent assignment to spread similar accounts. Reservations are
scheduling hints, not exact token budgets. Disabling Use for Auto does not stop
existing sessions or prevent an explicit manual selection.

Auto model discovery combines catalogs from enabled, authenticated accounts so
models exclusive to one account remain selectable. A failed named-account
catalog read advertises no fallback models from other accounts.

Session creation persists `AgentSession.codexAccountId`. All human, child,
periodic, reviewer and dedicated-PR creation goes through the same session-data
binding policy. Existing sessions retain their original account for runtime,
browsing, native history, model/launch discovery and usage. Legacy rows are
backfilled to Native default; null legacy bindings resolve only to that profile.
An existing Codex conversation requires exact resume; missing history or a
changed account identity never silently starts a conversation on a different
account.

Native default pins the provider scope when native file credential metadata is
available. Keyring-backed setups instead pin an unverified email fallback; that
fallback does not verify the provider/workspace scope. When the same email later
reports verified file-credential scope, the pin upgrades to that scope. Ending a
browser login refreshes only that account's cached status, so in-flight reads of
other accounts still complete. If a later native CLI sign-in changes the pinned
identity, run `ff codex login` with the original account to restore those
conversations; add a managed profile for a different account. Stopping a
provider process clears its session commands on connected clients as well as in
the server's replay cache.

The Add dialog verifies distinct account identity; adding the same login twice
does not create extra quota. Managed authentication ignores inherited
provider/API key overrides. Native default keeps existing API-key and
environment behavior. Global CLI authentication status cannot block a usable
managed profile.

Data export/import preserves saved account IDs but does not export credentials
or profile directories. Import reuses a verified matching local account or
creates an unavailable managed profile that requires sign-in. Imported sessions
never silently adopt this machine's Native default login. Cross-machine
credential/profile transfer is outside this MVP.

Claude accounts, automatic mid-conversation account migration, automatic failed
prompt replay and generated context handoffs are deferred. The live macOS spike
verified separate Codex accounts, quota reads, concurrent ACP prompts,
profile-local history and exact provider-process resume. Native keyring, forced
token-refresh and logout isolation still need separate live checks; managed
profiles use native file credential storage.

### Usage and compaction

The composer usage control shows the latest ACP `usage_update.used` against
`usage_update.size`. These are current conversation occupancy snapshots,
including post-compaction readings; cumulative token accounting is separate.
Unknown occupancy stays unavailable until the provider reports it. Snapshots
sent while attaching to an idle resumed session bypass history replay
suppression, so occupancy and Compact survive a backend restart. Both providers
support the same control.

Plan limits are account-level readings shared across workspaces, available only
to trusted local clients. The session capsule coalesces and caches provider
reads for 30 seconds. Codex uses the packaged app-server's `account/read` and
`account/rateLimits/read`; Claude uses its SDK's experimental structured usage
control with behavior scanning disabled. These disposable probes submit no model
turns and do not alter active conversations. Missing subscription data is
unavailable, and failed reads offer refresh rather than implying an unused
quota. Claude's experimental response is validated at the boundary and may need
updating with future SDK releases. Windows quota probes launch the packaged
native Codex executable directly; Unix probes own a detached process group for
reliable descendant cleanup.

Compact sends `/compact` through the normal session queue, preserving the
composer draft and excluding draft attachments. It is disabled while work is
running, compaction is active or the connection is unavailable. Native
`clientCapabilities.session.compaction` negotiation enables typed compaction
updates. Start updates show progress; only completed updates add the concise
context boundary. Duplicate terminal metadata patches do not create duplicate
boundaries. Failed and cancelled compactions end progress with their outcome and
never claim success. Retained model summaries are not rendered as new assistant
answers; conversation history remains visible.

Run the opt-in live check with:

```sh
RUN_REAL_PROVIDER_COMPACTION_TESTS=1 pnpm exec vitest run src/backend/services/session/service/acp/acp-compaction.manual.integration.test.ts
```

It creates disposable sessions for both providers, seeds a marker, compacts,
checks native usage/lifecycle updates and verifies follow-up recall without tool
calls. Native compaction can increase occupancy for short conversations, so the
UI reports the provider reading without promising a particular reduction.

### Failed provider resume

An active session whose provider cannot load its stored identity explicitly
reports `resume_fallback` (load failed or load unsupported). Browsing continues
to fail without creating a replacement. Startup keeps the replacement runtime
unavailable until the lifecycle owner reconciles it.

A Codex `thread_active_writer` load failure preserves the stored conversation
and reports that its other client must release it before retrying; it never
creates a replacement. Development backends running alongside the main backend
must use separate `BASE_DIR`/`DATABASE_PATH` values to avoid sharing session
ownership. After a legitimate fallback commits, startup accepts the replacement
identity's durable native access and reasoning snapshot.

The lifecycle owner archives the currently observed transcript through the
existing closed-session history before clearing provider messages from the
active chat. Durable stop evidence stays with the AgentSession; provider-owned
history files are never modified or deleted. With no observed messages, no
archive is created. The replacement starts a fresh provider conversation, and
does not have the old conversation as model context.

A dedicated compare-and-set operation changes the existing AgentSession's
provider identity, matching ACP config snapshot, and `providerIdentityRollovers`
audit together. It matches the old identity, metadata, and update timestamp;
ordinary identity writes still enforce immutability. The audit records the
runtime incarnation, reason, old/new identities, and archived message count. An
archive or reconciliation failure aborts startup and terminates the candidate,
preserving the old active transcript and identity. A stop racing a successful
commit leaves the new durable identity available for the next restart. An
archive created before a cancelled or failed commit remains available as a
retained copy.

Pending configuration notifications carry an internal source capability to the
configuration owner while public runtime lookup still hides their candidate. The
source remains valid after creation clears. Its existing stop-generation fence
rejects observations during a stop attempt, and exit or replacement invalidates
it, including through the guarded snapshot write. If stopping fails and retains
the same live runtime, observations may resume once that stop attempt clears.

Runtime incarnation/stop fences reject stale repair callbacks. A process that
has exited by code or signal fails the liveness fence, including when an
external signal kills a candidate during identity reconciliation. Failed-load
replay is discarded before `newSession`; replacement updates stay buffered until
repair succeeds. History hydration ignores reads started under an older
identity, even when they finish after rollover, and retry cooldowns reset for
the new identity. After backend restart, the reconciled column is the
authoritative history ID.

Startup buffers at most 10,000 ACP events while provider creation and identity
persistence are pending. Overflow cancels startup and terminates its candidate;
it never installs a runtime with a silently truncated transcript. Rollover
fencing rejects further reconciliation after overflow, and a later startup can
retry.

### Session prompts

ACP init/load uses the provider's built-in instructions; Factory Factory does
not supply a custom system prompt. Task prompts are sent as ordinary session
messages:

- Issue starts: `src/shared/issue-start-prompt.ts`, shared with the editable UI
  preview. It supplies untrusted issue data, the implementation/PR outcome,
  repository-defined verification, and screenshot/PR metadata.
- PR updates: `src/backend/prompts/pr-event.ts` renders bounded PR facts with
  maintenance instructions only when an attached PR has actionable events.
  Delivery uses the source-aware session queue and strict provider resume; see
  [PR updates](pull-requests.md).
- Quick actions: `prompts/quick-actions/` (see below).
- Child workspace starts append `buildChildWorkspaceContext` through workspace
  initialization. Workspace metadata generation runs separately from working
  sessions; it never injects branch-renaming prompts into the conversation. See
  [conversation names and summaries](workspace-state.md#conversation-names-and-summaries).

Legacy workflow templates and unused system-prompt construction have been
removed. Stored workflow IDs still select session behavior and permissions. Keep
prompts focused on outcomes and actual automation contracts, and defer
repository-specific tools and verification commands to repository guidance.

Claude ACP retains its bare Claude Code preset and existing prompt snapshot
behavior. Before introducing custom system-prompt metadata, revisit the SDK's
custom/append snapshot semantics. See
[the upgrade validation](../superpowers/plans/2026-09-09-remaining-dependencies.md).

Scheduled Codex tasks retain their YOLO access preset and scheduled Claude tasks
retain their configured access preset. MAIN PR updates inherit their main
conversation’s configuration. DEDICATED updates use the workspace’s provider
selection and normal user model defaults; later updates reuse that dedicated
conversation’s saved configuration. PR updates do not use a workflow-specific
permission preset.

Chat command composition belongs to `routers/websocket/chat-message-router.ts`;
application commands receive plain contexts and typed outcomes. Loading prepares
history asynchronously, captures current runtime/recovery/replay synchronously,
then publishes replay at the transport boundary without yielding. Application
completion owns runtime updates, capabilities, options, slash commands, and
initial-message activation in that order. Capabilities and options share one
configuration resolution per completion and publish consecutively after a
synchronous live-handle recheck. Load activation uses the supplied application
graph's dispatcher. See [chat message flow](../chat-message-flow.md) for
reconnect, recipient, and failure contracts.

## Event creation ownership

Event execution is not wired to a launch consumer yet. The dormant
`createEventWorkspaceOnce` and `createEventSessionOnce` APIs accept reserved IDs
from an admitted event run. They create their entity and retained launch origin
in one transaction. Workspace origins survive workspace, run and project
removal; session origins survive session and workspace removal. A retained
origin without its live entity blocks recreation, including deletion before run
linkage. Archived workspaces and projects also block creation/reuse. Generic
interactive, child and periodic creation keeps its existing behavior.

The agent-definition owner exposes `readEventExecutionBinding` and
`freezeEventExecution`. Freeze checks the current worker/attempt, lease,
reserved IDs and PENDING delivery identity, then stores immutable effective
execution without changing admitted snapshots. The original reserved message ID
stays fixed; a later explicit retry can rotate the delivery's message ID and
send-attempt ID. Generation checks fence earlier callers.

Future launch orchestration must select a Codex account under
`withAccountReservation`, freeze its ID before session insertion, and use that
same ID on recovery or fail. Session creation validates that exact account via
the application graph's account service without selecting Auto or entering a
second reservation. Disabled, missing or unauthenticated frozen accounts do not
fall back. Origins store account IDs and a strict versioned execution intent,
never credentials. The first session insert checks the run's frozen execution
and reserved workspace/session/project identity in its transaction through a
narrow read-only integrity check. Session reuse compares that original intent
rather than mutable model/launch metadata. Initial dispatch must later pin the
origin's settings even if a human has changed ordinary conversation settings.

Event sessions use `event-agent` and explicit `non_interactive` intent, with
ratchet disabled at workspace creation. They do not inherit periodic Codex YOLO
permissions. These APIs neither initialize a provider nor dispatch a prompt;
observed delivery, setup/restart orchestration and runtime wiring remain
separate work.

The strict event workspace initializer shares the ordinary initializer's
per-workspace queue and worktree preparation. It validates the reserved session
and current run claim, then runs factory setup and project startup scripts
without the ordinary auto-message or first-IDLE-session path. Workspace writes
recheck the claim, lease, retained origins and live entities in the workspace
owner's transaction. An aborted or superseded initializer cannot publish a late
worktree or READY. The caller owns run linkage, lease renewal and eventual
initial dispatch; the initializer does not enqueue or send a prompt. No claim
consumer is wired yet.

Event setup has a fifteen-minute deadline. Uncancellable Git work remains owned
until it drains; timeout does not abandon its promise. Abort and script timeout
stop the current owned setup process group and distinguish confirmed cleanup
from UNKNOWN. Unknown cleanup forbids retry or capacity release. Ordinary
nonzero script exits still produce READY with a warning, and successful scripts
may retain background dev servers. Invalid configuration and execution errors
return explicit failures. Event initialization does not create an unattended
terminal or send a Linear status update; a user can open a terminal afterward.
Ordinary interactive, child and periodic initialization retain their policies.

## Session lifecycle ownership

`SessionLifecycleGate` owns domain startup/stop eligibility. Workspace
initialization reserves the initial session launch before publishing READY. The
runtime machine keeps idle startup and dispatch-preparation updates in
`starting` until work begins, startup/dispatch exits, or a stop or error ends
the launch. Ordinary queued follow-ups do not acquire this reservation. Runtime
reads preserve `starting` after a provider handle becomes live, until the
startup owner finishes configuration and persistence. A live process with no
prompt in flight is not sufficient evidence of idle during startup; dropping
that phase can move a newly ready workspace into Waiting before its first turn.
`AcpRuntimeSupervisor` is the sole mutable ACP runtime authority: it owns
subprocess handles, pending creation, incarnation filtering, exits, stops, and
quiescence. `AcpRuntimeManager` is the stable compatibility facade over the
supervisor and stateless ACP collaborators. Lifecycle coordinators continue to
own durable reconciliation and never manipulate runtime registries directly.
Runtime callbacks use `onRuntimeExit` and `onRuntimeError` events carrying the
supervisor's incarnation identity and current purpose. Exit events also carry
whether the stop was managed; coordinators consume this metadata directly,
including after a browsing runtime is promoted to active use.

Graceful server shutdown persists active sessions as `IDLE`, matching explicit
stops. PR delivery remains paused after an explicit stop until user
continuation. Runtime-managed exits without a shutdown reservation still use the
exit code to determine terminal status. Bulk shutdown retains its non-browse
lifecycle reservations through event recording and runtime shutdown, then
releases them on every exit path. Shutdown waits for a concurrent explicit
stop’s lifecycle write and suppresses a duplicate event only after durable
success. A failed write retries the same event identity, replacing its transient
banner if persistence recovers. Stops that suppress their own event still
receive shutdown history. The supervisor's closed shutdown admission remains in
effect after gate cleanup.

Queue execution belongs to the single `SessionDispatchService` configured in
`session-services.ts`. Initialization, notification delivery, lifecycle queue
recovery, and prompt completion use its dispatch capability directly. The chat
registry's dispatch, reset, and manual-resume callbacks reach that same instance
through the transport-owned chat router. Lifecycle generation, delivery claim,
and transcript-commit ownership remain with their existing services.

At the next turn boundary, dispatch combines queued human messages and workspace
notifications in FIFO order into one provider prompt. A ready PR update batch
joins that prompt; a blocked PR update does not delay human messages. The latest
human message supplies the turn's settings. Slash commands remain standalone
turns so provider commands such as `/compact` retain their meaning.

Each message retains its own dispatch state and local transcript entry. A busy
provider restores the batch in order, while invalid attachments reject only
their own message. Cancelling a message during preparation retries the remaining
queue. Successful provider receipt commits the entire batch before separate
notification and PR acknowledgements; acknowledgement failures do not roll back
human messages. Provider history retains the combined human text and restores
trailing PR content as a compact update row.

Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility        | Owner                                | Reconciliation point                                      |
| --------------------- | ------------------------------------ | --------------------------------------------------------- |
| Startup               | `SessionStartupCoordinator`          | Persisted `RUNNING` state                                 |
| Termination           | `SessionTerminationCoordinator`      | Persisted idle/stopped state                              |
| Runtime exit          | `SessionRuntimeExitCoordinator`      | Terminal status and unexpected-exit lifecycle history     |
| Notifications         | `SessionNotificationDeliveryService` | Transcript plus delivered evidence                        |
| Context               | `SessionContextService`              | Operational precondition; no durable-state reconciliation |
| Workflow finalization | `SessionWorkflowFinalizer`           | Idempotent workflow completion                            |

When changing lifecycle behavior, keep these boundaries intact: coordinators and
services own their named responsibility and reconciliation evidence where
applicable; context supplies operational inputs. The lifecycle facade delegates
public operations and the session composition root wires the owners.

## Task lists

The current task list appears inline beneath the conversation in workspace chat
and quick chat for both Claude and Codex. The UI uses the latest ACP plan
snapshot, including empty snapshots that clear the checklist. Older Claude
TodoWrite calls provide a fallback when no ACP plan has arrived. Completed tasks
remain visible and muted. Task lists stay hidden during session history loading;
session switches reset their ACP state. The former Tasks sidebar tab is removed,
and saved selections of that tab migrate to Changes. The session store retains
the latest validated ACP task snapshot for reconnect replay, including empty
lists. Plan snapshots emitted during provider history attachment pass replay
suppression so restored conversations can recover tasks. Authoritative session
snapshots include the current task list, so queue updates preserve valid tasks
and hydration clears stale client state when no list exists. Replacing a
provider's archived history also clears its task snapshot.

## Provider sub-agents

Provider-initiated sub-agents are session-scoped, read-only, and provider-owned.
Factory Factory projects their native ACP metadata and transcripts into the
Sessions panel through its session-scoped tracker. Clicking the running
sub-agent count in the main chat expands an inline list of active sub-agents;
selecting one opens its transcript tab directly. Completed sub-agents remain in
Sessions. The inline list deduplicates overlapping provider pages and retains
pagination and Retry controls when later pages are unavailable. The Sessions
panel's stored key remains `agents`; child-workspace access remains available
for parent workspaces. The count shows the assigned icons of up to three active
sub-agents in creation order; larger groups keep the full count without adding
more icons. Until all summary pages load without errors, the count remains
visible without placeholder agent icons. The Sessions list, lifecycle rows, and
sub-agent tabs share twelve nature icons assigned by session-wide creation order
(with agent ID breaking ties), keeping assignments when agents finish.
Additional agents use distinct numbered badges instead of repeating icons. Tabs
preserve the assigned icon color and pulse while starting or running. Unknown
creation times sort last. Its header counts active (starting, running, or
waiting) sub-agents; terminal agents remain under the separate collapsible
Completed count. The panel automatically loads all summary pages before showing
the active count, so children on later provider pages are included. A page
failure keeps loaded rows visible and offers Retry without displaying a partial
count. Repeated provider cursors stop automatic pagination and offer the same
recovery instead of repeatedly fetching the same page. Sub-agent tabs also load
all summary pages, even after finding the selected child, so earlier-created
agents on later pages receive the same icon ordering. Restored transcript
selection uses the same cursor guard. Live sub-agent events invalidate list
queries by parent session, without cursor or page-size fields, so infinite-query
caches refresh newly spawned and completed children without a page reload.

The chat timeline projects provider creation and completion timestamps into
separate, muted sub-agent start and finish rows. Failure, cancellation, and
interruption retain their own labels. In workspace-detail chat, these rows open
the Sessions panel. Both workspace-detail and Quick Chat reconstruct the rows
from provider metadata when history reloads; unknown timestamps are not
invented. Native ACP replay without provider timestamps retains sub-agent
summaries and transcripts for browsing but leaves lifecycle times unknown, so
reopening a workspace does not append historical starts and finishes as new
activity. Live native events still use their observation time. If a request
fails or the provider repeats a pagination cursor, chat keeps known rows visible
and offers Retry. Adjacent tool activity stays collapsed by default as muted
summary rows; expanding a summary shows chronological calls with input and
output available on demand. Failed calls remain visible in the collapsed
summary.

Sub-agent transcript projection applies the same refinements without duplicating
tool cards and joins consecutive assistant text chunks before rendering
Markdown. Tool, reasoning, non-text content, and provider message-ID changes end
the text sequence, preserving separate replies and tool ordering.

The transcript follows the main chat's visibility rules: reasoning-only entries
are hidden, and tool sequences expand to show earlier activity. A child that
writes only final replies can therefore look like a short result summary even
when its complete tool history is available. The scroll-to-bottom control
appears only in reading mode when content remains below the viewport. The
content-below measurement is independent of reading intent, so fitting content
hides the control without resuming automatic following.

They are distinct from workspace-scoped child workspaces, and are recovered from
the provider when a parent session is reloaded rather than persisted by Factory
Factory.

## Child workspaces

A parent workspace can spawn child workspaces (in any project) via MCP tools
exposed to the agent (`spawn_child_workspace`, `send_message_to_child`,
`archive_child_workspace`, `list_projects`). Children report back via
`send_message_to_parent`.

Child-workspace MCP requests connect to localhost when the backend binds to an
IPv4 or IPv6 wildcard, including equivalent compressed IPv6 spellings. Explicit
bind addresses remain the connection destination.

Messages are persisted first as `WorkspaceNotification` rows, then delivered
live to active sessions when available; undelivered rows are delivered at the
next session start. Max depth is 1 — children cannot have children.

Child creation validates the target project's active status before delegating to
its injected workspace-launch owner. The workspace capsule still validates the
parent and depth and persists the parent, prompt, and report-back metadata.
Unlike interactive launch, the child policy resolves its provider after
persistence and attempts a `followup` / `Chat 1` session only when provider
resolution succeeds. It performs no capacity or CLI-health preflight. Provider
or session failure is best-effort; initialization still starts once in the
background. Parent notifications and child context handoff remain with their
existing owners.

UI: `ChildWorkspacesPanel` in the right panel, a child badge on kanban cards,
and an archive warning when a parent has active children.

- Orchestration: `src/backend/orchestration/workspace-children.orchestrator.ts`
- MCP entrypoint: `src/backend/mcp/workspace-mcp-server.ts`
- Session MCP spawn configuration:
  `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`

## Quick actions

Workspace quick actions are markdown-driven from `prompts/quick-actions/`
(frontmatter metadata + prompt body). Agent quick actions create follow-up
sessions and auto-send the prompt content once the session is ready.

`prompts/` is copied into `dist/` on build and packaged alongside the unpacked
Electron backend, so a new prompt file ships without a code change.

## Desktop backend process

The desktop app runs the backend in an Electron utility process, not in Electron
main, so synchronous SQLite work, agent streams and terminals cannot freeze the
window or menus. `electron/main/server-manager.ts` forks
`src/backend/electron-utility-entry.ts` and passes the database, migrations,
frontend and log paths through the child environment. The child runs migrations,
starts the server, and posts `ready` with its URL or `error` over
`process.parentPort`; startup that takes longer than two minutes is killed.

On macOS a utility process runs from the Electron Helper binary, so Electron
main also passes its own executable as `FF_NODE_EXEC_PATH`. Bundled adapters,
provider CLIs and the child-workspace MCP server launch with
`configService.getNodeExecPath()` and `ELECTRON_RUN_AS_NODE=1`; outside Electron
it is `process.execPath`.

Electron main stops the backend before quitting (`before-quit`) and when the
last window closes. Stopping sends `shutdown`, waits 25 seconds for a graceful
exit, then sends `SIGKILL`. A stop during startup cancels the start the same way
instead of waiting for the backend to become ready; the start then rejects even
if `ready` crosses the shutdown request, and the cancellation is not reported as
a startup error. Once quitting begins, activating the app does not start a new
backend. If a started backend exits on its own, the app offers to restart it,
reloading the window at the new URL, or to quit.

Electron fatal-error handlers await backend shutdown before quitting. Concurrent
fatal errors share one shutdown attempt. Cleanup failures and a 30-second
shutdown deadline are logged before the application exits, so a stalled startup
cannot hold the fatal-error path open indefinitely.

### Targeted interruption

Expanded background-process rows in chat and controllable sub-agent rows in the
Sessions panel expose an icon-only Stop action. Each action has its own disabled
spinner until live provider updates remove the work or withdraw its capability;
request acknowledgment does not invent completion. Failures use a toast and
allow retry. Pending attempts and their original deadlines survive list/panel
remounts, and confirmation waiting is bounded to 15 seconds. Disconnecting hides
controls, and stopping a row remains separate from selecting its transcript.

The session-scoped `stopTarget` mutation validates an opaque live control ID
against the current active runtime's native tracker before dispatch. UI
references also carry the tracker's runtime identity, matched to the live work
snapshot. Current-connection hydration and a successful child-list refresh gate
controls after reconnect/runtime replacement; cached rows stay browseable while
controls wait for current capability data. Controls are renewed for child/task
generations and withdrawn during history replay, completion and capability
withdrawal. Browsing extensions and browse-only runtimes cannot grant control. A
stop never starts or restores a runtime. Background tasks require explicit
`canStop` and dispatch `_session/async_task/stop` with the root provider session
and retained task ID; child ownership separately fences tasks from superseded
child generations. Native child interruption requires an explicit
`capabilities.cancel` and sends `session/cancel` to that child's current ACP
session ID, preserving the parent and unrelated siblings. No parent-cancellation
fallback is used. Omitted native child patch fields keep their prior values; an
explicit `capabilities` object replaces the set, and `{}` or `null` withdraws
control.

The currently installed Claude and Codex adapters select the JetBrains Air (AIR)
private ACP extension contract, negotiated through
`clientCapabilities._meta.jetbrains.air` (including `asyncTasks`), for native
sub-agents and background tasks. They advertise no child cancellation capability
in that form. Their child rows therefore remain browseable without Stop. The
tracker accepts explicit cancellation metadata for known current native
children, including `subagent_update` capability changes, without changing
protocol negotiation or claiming support for a separate standard-protocol
lifecycle. Background-task stopping remains available where AIR advertises
`canStop`.

## Event initial delivery infrastructure

Event-owned sessions have a retained creation origin and a durable initial
prompt fence. Orchestration must inject the agent-definition owner's delivery
port before event startup or recovery. Missing or unavailable authority blocks
those sessions, including before observers are restored. Ordinary conversations
keep their existing policy; a durably finished initial delivery permits later
human turns after restart.

The dormant `dispatchAgentInitialPrompt` API targets the reserved session and
sends one initial turn using its frozen execution and account binding. Its
caller supplies a synchronous current-claim guard. Human input stays in the
ordinary queue during setup and delivery. Queue reset, retry, manual resume,
steering, direct startup and configuration edits cannot remove the durable
fence. This infrastructure does not enable an event launch consumer.

The send boundary persists SENDING after session serialization and provider
configuration readiness. It then rechecks the captured runtime, lifecycle and
claim before calling the provider. A failed pre-send write prevents invocation;
failed later evidence writes retain uncertainty. Current ACP v1 provides no
caller message idempotency key or conclusively correlated early acknowledgment,
so generic live activity and replay do not mark ACCEPTED. A response to the
captured prompt RPC records a terminal outcome directly. Local transcript rows
are display data, never acceptance evidence. Unknown provider history must not
be treated as proof of non-delivery.

AgentInitialDelivery stores versioned, validated runtime identity, sanitized
terminal outcome and stop evidence. Every write compares the current run worker
and delivery attempt. The original run initialMessageId remains unchanged when
an authorized retry rotates the current delivery identity. Terminal outcome
alone does not settle the run or release capacity; tracked agent work is a
separate reconciliation concern. Later human results cannot overwrite it.

Event runtimes use an owned POSIX process group. Strict stop confirms
LOCAL_RUNTIME_GROUP_STOPPED only after observing that group disappear. Adapter
exit, a signal acknowledgment, cancellation acknowledgment, a missing handle or
an IDLE snapshot is insufficient. Unsupported executable overrides, Windows
without conclusive tree evidence, and uncertain cleanup report UNKNOWN. Live
ownership is required; persisted PIDs are never used to signal a group after
restart. Legacy runtime launch and stop behavior is unchanged.

Group disappearance proves local runtime termination for the supported inherited
provider launch chains. It does not prove that remote or detached owned work is
quiescent, nor undo earlier external effects. Retry requires local runtime stop
and resolution of tracked owned work. USER_STOP, shutdown, timeout and
unexpected exit remain distinct causes. Shutdown interruption preserves
reconciliation and no-resend semantics instead of inventing a user cancellation.
Observation writes are awaited before completion; shutdown bounds its drain and
still attempts physical cleanup when persistence fails or times out. Missing
durable stop evidence remains an error and cannot authorize retry or capacity
release.

Event stop separates immediate owned-runtime termination from creation and
observation draining. Startup failure cleanup never waits for its own creation
registration. Stop and shutdown drains have deadlines: stalled creation remains
fenced, uncertainty is retained, and cleanup proceeds for remaining sessions.
Unexpected adapter exit attempts cleanup of its current owned group even when
durable exit observation fails. Definitive spawn failure before any process is
created preserves the spawn error; a missing PID alone is not that proof.

Observation draining tracks complete read/write operations and waits for all
settled results. A timed-out drain closes its observation epoch so late reads or
writes cannot initiate another owner write. Already-started database operations
may finish; shutdown does not claim they were rolled back. Durable failure does
not suppress best-effort physical cleanup. A soft cancellation while the
pre-send write is pending prevents the subsequent provider invocation and keeps
uncertain persisted delivery fenced.

Concurrent cleanup callers share compatible physical stop work for the current
owned runtime; each caller retains its own stop cause. A caller's timeout does
not release physical stop fencing while termination is still running. Queued
quiescence callers recheck the active barrier before taking ownership, and
creation-internal cleanup continues to use the nonjoining physical primitive.
