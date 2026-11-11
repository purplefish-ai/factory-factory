# Agent Runtime

Application updates use a process-wide admission gate shared by session input,
dispatch, runtime creation, workspace provisioning and background agent
launches. The update job waits for active operations, pending initial/queued
messages and active agent turns, then closes admission synchronously before
notifying the CLI supervisor. Idle ACP processes do not hold the update. A
rejected input remains available to retry after reconnecting. Failed preparation
reopens admission. Cancellation before readiness also reopens it. After
`update-ready` has been sent, cancellation keeps the gate closed until the CLI
supervisor acknowledges an idle status, because preparation may already have
started. Shutdown keeps admission closed until the process exits.

The production CLI owns installation, recovery state and backend restart. It
stages a pinned npm release before stopping the backend, backs up the database
before migrations, and keeps the previous package until the replacement reports
full startup readiness over IPC. Interrupted recovery runs before migrations and
relaunches the restored CLI. The supervisor retains durable update status
outside the replaced package, including errors after the backend has stopped.
Its restorable snapshot is separate from the bounded `db-backups/` copy every
launch and `ff db:migrate` take before pending migrations (see the README's
database upgrades section); both use one SQLite online-backup helper,
`src/backend/lib/sqlite-snapshot.ts`.

Automatic installation supports writable global npm installations on macOS and
Linux launched through supervised `ff serve`. Eligibility is fixed at startup;
if another server already uses the installation, close those servers and restart
this server to reevaluate eligibility. Unsupported modes show manual guidance.
Update and cancellation mutations require a trusted local client and validated
IPC. The supervisor serializes installation of a pinned advertised release.

Provider update notices compare adapter-resolved runtime package versions,
published as `factoryFactoryRuntimeVersions` by the `prepack` script. Version
discovery resolves exported runtime entrypoints when package manifests are
hidden by exports; dependency ranges alone do not establish installed versions.
Claude and Codex share the Factory Factory update action rather than updating an
unrelated global provider CLI.

The nonblocking banner shows independent release rows with one shared update
state. Dismissals persist per provider and available version; the previous
Factory Factory dismissal key remains a fallback for older clients. Registry
failures preserve confirmed data without blocking normal use. Recovery errors
remain visible even without release rows, and retries retain the failed target
when registry metadata is unavailable. A new request clears that target's reload
guard; after reconnecting, the browser reloads once when the server reports the
target version, only if the guard can be persisted. Seeing a different running
version also clears the old target's guard. Dismissing a row does not cancel an
accepted update. The legacy `checkFactoryUpdate` query supports older clients.

ACP admission is injected by composition to preserve dependency isolation.

Rejected or failed messages restore their text and attachments only when the
current session composer is empty. A newer draft or attachment selection is
preserved, and clearing it later does not replay the earlier recovery.

Chat drafts restored before the composer mounts are visible on its first render
and retained when typing begins after a reload. Selecting another session shows
that session's draft and attachments from its first render; the previous
session's are never shown in its place.

Claude session history restores inline image blocks as attachments on the
original user prompt, including image-only prompts. Harness metadata, sidechain
entries, `/compact` summaries, and image-reference companions are omitted from
chat replay; their temporary file paths are not read. Background task-stop
notifications marked by Claude's origin metadata are also omitted, while
delivered prompts carrying an origin subkind remain visible. Codex history
likewise restores user `input_image` data URLs, and images on legacy
`user_message` events, onto the prompt; non-user images and `local_images` paths
are skipped. Restoration rejects malformed base64 and images above the shared 10
MiB decoded size limit used for uploads.

Chat Markdown and structured tool-result images share an inline preview with a
full-size dialog. Local Markdown paths load through `workspace.readChatImage`,
which requires an existing workspace and restricts reads to that worktree or
absolute OS temporary-file paths (including `/tmp` on macOS). Relative paths
cannot escape the worktree; resolved symlinks must stay within the selected
root. Only PNG, JPEG, GIF and WebP files with matching image signatures are
returned, with bounded reads and a 10 MiB limit. Missing, unsupported or failed
images show a selectable source path or URI. Temporary previews require the
original file to remain available after reload. Codex image-bearing tool outputs
retain structured image items on replay rather than serializing their base64 as
text.

Provider history hydration retains the yielding 1 MiB JSONL reader. Dense blocks
and transcript projection use a 16 ms cooperative target. Projection uses the
same per-entry builder as synchronous callers and yields between small batches,
preserving complete content, deterministic IDs, ordering, and timestamps.
Provider identity checks stop superseded reads and discard unfinished projection
before publication. A single JSON.parse or projection entry remains atomic;
particularly large tool results, garbage collection, or host scheduling can
still exceed the target. This budget improves responsiveness; passive loads
still await the complete history and can trade throughput for yielding.
Cancelling one startup consumer leaves a shared, still-current hydration
available to other consumers. Stopping the session invalidates its shared
hydration generation before publication; a later startup starts fresh hydration
instead of joining the superseded preparation.

Passive loads, startup and workflow finalization share one provider history read
and projection per session, provider identity, worktree and Codex account
(`data/provider-history-transcript-loader.ts`). Each caller applies the result
through its own domain and fences. The read stops only when every caller is
stale and is never cached then; a caller that is still current starts afresh. A
caller never joins a read with a stale caller, since a stop, reset or rollover
after the read began may have changed the file.

Completed projections stay in `ProviderHistoryTranscriptCache`
(`data/provider-history-transcript-cache.ts`), so reopening an idle session
whose store was cleared can skip the read. Entries are keyed by session,
provider, provider session ID and file path, and serve only the exact file
identity (path, size, modification time and inode) observed before and after the
read; a changed file is reread and replaces its entry. The cache holds only file
projections, never store state, so clearing a store keeps its preservation rules
and later loads merge retained local entries as before. Each store receives its
own copies of the transcript entries, since stores may reassign an entry's
fields in place. It keeps at most 16 entries and 128 MiB estimated from file
sizes, evicting the least recently used first. An entry used by a live store
does not expire; `session_cleared` starts a five-minute TTL and permanent
deletion drops the session's entries through `SessionScope`.

Cold resumes overlap history hydration with adapter spawning and ACP
initialization. Provider session loading/creation waits for the history barrier,
which restores timestamps and establishes replay suppression before provider
history events can arrive. Stop, shutdown, and initialization failure still
terminate or fence the candidate before session RPCs. Provider deadlines apply
to initialization and session creation; the local history barrier retains its
previous independent wait. Passive chat loads continue to await complete history
hydration.

Replay batches up to 128 KiB retain their existing envelope. Larger batches use
normal JSON event frames, with base64 fragments for an oversized event. When
batch metadata itself cannot fit in a JSON event frame, the entire batch uses
base64 fragments instead. The client rejects direct replay batches above 128
KiB; every complete wire envelope stays within that bound, including large tool
results and images. The server serializes each event once and sends frames built
from that JSON; the client measures each received event once for both the frame
bound and the declared replay length. The client reconstructs the exact batch
atomically before applying the existing load-request guard; incomplete,
malformed, or out-of-order chunks cannot publish a partial transcript. Assembly
expires after 30 seconds and resets on disconnect, session change, or unmount.
The transport rejects batches above 128 MiB explicitly. Framing bounds each
message, rather than reducing total replay bytes or adding pagination; the
existing renderer transcript window and full backend transcript retention still
apply.

Main and quick-chat transcripts initially load the newest 1,000 entries. Near
the top of the loaded transcript, the client automatically requests older pages
of up to 500 entries from `session.readTranscriptPage`, using the first loaded
persisted message ID as an exclusive cursor. A page starts at a render-safe
boundary; preceding fragments remain available on the next request. The read
uses the already loaded backend transcript without provider hydration, startup,
configuration, or queue dispatch. An evicted or replaced cursor fails explicitly
and requires reloading the chat.

Requested history stays in renderer memory until a hydration snapshot, replay,
clear, or session switch. Nonempty live snapshots replace only their recent
window and preserve the loaded prefix; explicit removals filter the listed
message IDs from retained history and in-flight page responses. An empty live
snapshot authoritatively clears the transcript and resets paging, fencing
responses from requests started before the clear. The existing virtualizer
bounds mounted rows. History merges by ID with current live entries taking
precedence, without replaying old runtime, usage, thinking, or task effects.
Request identities fence stale completions. Loading failures and connection
interruptions retain visible messages and offer Retry. Failed requests restore
the previous renderer limit and page boundaries; unavailable connections disable
Retry. Idle and completed history show no header text or load button, including
during workspace initialization. The loading header appears only after a request
has been pending for 250 ms, so fast history checks do not briefly insert a row
above the messages. Errors and Retry appear immediately. Prepending preserves
the content anchor, including when the loading header is visible at the very
top. Content anchors skip zero-height rows such as hidden thinking blocks. The
stable history row shares the normal leading padding. At the top, header growth
leaves loading feedback visible; header collapse compensates to preserve the
content anchor. Reaching the oldest entry stops paging without a beginning
marker. Tool groups stay split at loaded page boundaries so prepending adjacent
tools preserves existing row keys and expansion state; late results still pair
across those boundaries.

Both managed providers accept image and text attachments. Connected conversation
composers accept image drops, uploads, and the upload shortcut while an agent is
working, so follow-up messages can be queued with attachments.

Upload validation checks the complete JPEG codestream through its end-of-image
marker and permits trailing metadata, including Samsung screenshot capture
information. Truncated image segments and scans remain invalid.

The new-workspace slash-command palette prefers project command descriptions
over same-named global commands, matching the workspace-first precedence used
when loading a Claude session. Commands found only in the global directory
remain available. Claude provider caches exclude `project:` and `workspace:`
commands, including nested names, regardless of disk-scan availability. Passive
loads also reject scoped entries left in an older global cache.

Stopping a session retains dispatched user prompts in the live transcript when
termination rejects the in-flight prompt RPC, unless the rejection proves the
prompt was never sent (steering, authority fences, a busy turn, or invalid
attachments). Unsent queued messages are still cleared. Background notification
and PR delivery entries retain their rollback rules so provisional transcript
content does not establish delivery.

Workspace notification recovery ignores provisional user transcript entries
while their provider dispatch is unsettled, including across session stop/reset.
Only settled transcript evidence can acknowledge delivery; a failed send leaves
its durable notification pending for a later startup to recover.

Child workspaces are enabled by default. Settings → General → Child Workspaces
can disable their controls, MCP tools, and creation through the UI or MCP.
Existing children and notifications are preserved. MCP checks the current
setting when listing or calling child workspace tools; disabled tools are
rejected even in running sessions. Start a new conversation after re-enabling if
its provider has cached the disabled tool catalog. Agent-authoring tools remain
available.

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

Archived PR receipt lookup reads provider identity through the session owner's
`readClosedSessionProviderIdentity` API. The actual Workspace FK supplies the
worktree root; relative legacy paths such as `transcripts/` remain readable,
while absolute paths, lexical escapes and existing-file symlink escapes are
rejected. Session/provider identity and workspace identity, when present, must
match the archive row. The bounded header probe can recover identity from a
pretty-printed archive with a truncated message body; complete compact or
reordered archives retain their full-file fallback.

Headers only select native provider history. Delivery still requires a user
marker from that scoped Claude/Codex history, using the original worktree path.
Closed-session rows have no account column: an absent header account is unknown,
distinct from an explicit default account (`null`). When a live Codex account is
known, archived identity must match it; an explicitly selected account never
falls back to another account or default history on failure. Legacy archives
without an account retain default-history lookup only when no live binding is
available; their headers do not independently prove account ownership.

The full `getTranscript` route delegates to the session owner's compatible body
reader, sharing the header reader's FK-root lexical and realpath containment. It
requires a JSON object with a messages array, retaining legacy role/content
rows, opaque metadata/version/summary and unknown fields, including own reserved
keys at every JSON depth. Malformed full bodies fail with safe application
errors even when the bounded header probe can still recover identity. Archive
storage performance and durability acceptance remain blocked; this reader change
clears neither gate.

The archive view reads `getTranscriptJson`, which returns the validated owner
DTO as JSON text through SuperJSON, then decodes it through the same compatible
schema. This preserves own `__proto__`, `constructor` and `prototype` fields
that SuperJSON rejects when traversing object output. The existing object
`getTranscript` endpoint remains compatible for ordinary data and retains that
serializer limitation. Structural sharing is disabled for this archive query so
changed selected objects retain reserved keys on refetch. A failed read with
validated data for the same query retains the history, including empty history,
with a persistent notice that the latest read failed and previously loaded
history is shown. Invalid new input never renders. Without prior validated data,
failures show a generic error; explicit missing archives hide cached history and
retain the not-found state. Valid recovery clears the notice.

The archive view uses `projectClosedSessionTranscriptRows` to validate each JSON
row with the current-message codec before read-only rich rendering. Opaque and
invalid rows appear as labeled, escaped JSON text. Projection preserves array
order and opaque barriers, using observations from the existing grouping owner
to identify exact consumed result blocks. A row with any unconsumed result
retains one entire raw fallback, even if part is already represented richly;
same-index rich content precedes that inspection row. Successful current rows
with undeclared extras remain rich-only, while the original API JSON stays
intact. Full bodies are presentation data; headers still only select native
provider history and never establish delivery proof.

## Chat tool previews

Chat tool previews format recognized MCP identifiers from both providers as a
readable action and service (for example, `Fetch PR comments · GitHub`). Unknown
tools use the same word formatting without requiring a tool catalog. Collapsed
activity groups count MCP calls by service; the full identifier and input remain
available in expanded details. File-list previews omit the target directory and
show `List files`.

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

`ff serve` observes each child immediately after spawning, including while
waiting for readiness or opening the browser. Any unexpected child exit
(including exit code zero) or spawn error fails the session and stops its
siblings. Interrupts cancel startup and join cleanup without starting additional
services. Serve and Tailscale share CLI process-tree termination: SIGTERM with a
five-second grace period, followed by SIGKILL for an unresponsive child.
Electron utility-process supervision remains separate.

Under `ff tailscale`, the backend owns loopback port shares (`port-share`
capsule, `/proxy/<port>` route). Each share runs foreground
`tailscale serve --https=<port>`. On Unix it runs as a detached process group,
because on macOS the `tailscale` command is a wrapper that leaves the real CLI
(and the share) running if only the wrapper is signalled. Backend cleanup stops
each group and then closes its in-process forwarder. Groups are recorded under
`<base dir>/port-shares/<backend pid>.json`; the next start stops groups whose
owning backend is gone. Windows has no process groups: cleanup uses `taskkill`
on the Serve process tree, and crash recovery is not available there. See
[the design](../superpowers/specs/2026-11-03-tailscale-port-sharing-design.md).

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
requests and keep successful results fresh for five minutes. Later reads return
the last success immediately while one background refresh runs; refresh failures
retain those results and retry after a 30-second cooldown. Catalog refresh
failures emit a sanitized warning once per attempt. Shutdown fences both catalog
services, aborts their disposable children, and waits up to seven seconds for
active work and physical child/pipe closure before account teardown. Caller
timeouts remain independent of physical drain; undrained processes retain their
cache's discovery admission rather than spawning retries.

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
offering Plan replaces the legacy planning toggle. Mod+Shift+P updates that
native option in both directions, choosing only an advertised `default` when
leaving planning. Without that choice the exit shortcut does nothing; it never
guesses a permission mode or queues a hidden legacy planning setting. Menus show
provider-supplied descriptions for settings and choices. On mobile, the options
sheet retains text labels.

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
results stay fresh for five minutes per provider/model/requested Codex account
(or Auto), then remain usable during request-triggered background refreshes,
without a hard expiry. Failed refreshes retain the last success and retry after
30 seconds. Cache size and concurrent discovery counts remain bounded. Cold
discovery failures offer Retry; creation waits for available options while model
selection remains editable.

Successful launcher options are persisted atomically to
`BASE_DIR/cache/session-launch-options.json`. A versioned Zod schema validates
restored metadata; missing, corrupt, or incompatible snapshots start cold.
Saving skips an unsupported entry without discarding other valid models.
Persistence errors do not block the launcher. Startup restores all retained
entries and warms the saved default model for each provider without delaying
server readiness. Restored entries refresh on their next use, including the
startup warmup, so runtime upgrades obtain new capabilities in the background.
Snapshots contain capability metadata, never credentials or runtime
environments. Shutdown immediately fences new discovery and aborts disposable
probe children. It waits up to seven seconds for native lifetimes and snapshot
writes before account teardown. Account observations already in progress cannot
be cancelled; a drain timeout is reported, and later observations cannot spawn
another probe.

Native discovery retains one of its eight admission slots until the disposable
child emits `close`, including closure of its stdio pipes, and its ACP
connection is logically closed. Operation/session-close timeouts and TERM/KILL
requests bound caller results but do not release that native lifetime. SDK
logical closure alone does not prove child drain. A lifetime that never closes
remains charged; retries share its bounded failure, or report discovery busy
when its successful cache entry is evicted. The success timestamp is not
refreshed while cleanup remains charged. This tracks the owned child and pipes,
without claiming containment of every SDK continuation or external descendant.

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
while later tag-only messages are kept as typed. Active and browse resumes start
on-disk history hydration before ACP startup, preserving original message
timestamps and suppressing duplicate adapter replay. Concurrent startups share
history preparation; joining a runtime already starting preserves its replay
policy. Without on-disk history or a retained provider transcript, ACP replay
remains the fallback; each replayed user message closes the open reply and gets
its own transcript row. Terminal output deltas are negotiated explicitly,
accumulated with per-tool and total pending-tool limits, and included in
completed tool results. Buffers are isolated by session and cleared on teardown.

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

Subagent lists and transcript headers display the child model reported through
native `config_option_update` model options. The model stays hidden until the
provider reports it (Claude reports after the first response); it is never
inferred from the parent. Child updates refresh the label, and stale Codex
generation updates cannot overwrite a resumed child's model.

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
is first resolved). The session-summary refresh (which also publishes the
workspace pending-request type) runs at most one query per workspace at a time
plus one trailing rerun, so a burst of one kind of event costs two queries
instead of one per event. Thought chunks are merged per 25 ms window like
assistant text. They are flushed before the next translated update, replayed
user message, runtime event, turn boundary or provider identity rollover, so
transcript order is unchanged. Permission prompts, which show outside the
transcript, do not wait for them. Chat shows background processes separately
from the active-turn spinner, with a process-count header that expands to show
their commands. The command list starts collapsed. Live status announcements
contain the process count separately from the control and commands. A completed
turn with a persistent preview server shows the remaining process instead of
stale reasoning or “Agent is working”. Task-detail changes publish even while
another task keeps the session busy, and reconnects restore current work from
the live runtime. Idle and error transitions discard cached work unless fresh
details are explicitly supplied; stopped transitions always clear work. A failed
turn retains fresh background details from the live runtime, and chat keeps
those processes visible alongside the error state.

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
earlier queue entry. Failed steering leaves the message queued. The client
immediately disables steering controls and shows “Steering…” for the selected
message. A requester-only `steer_settled` acknowledgment or correlated error
releases this pending state; disconnection and session changes also clear it. A
steering acknowledgment has a 10-second deadline. On timeout, the client
terminates that runtime before releasing queue ownership and withholds immediate
automatic resend. Input may have been consumed before the missing
acknowledgment, so a later explicit retry may repeat prior effects. The host
requests `idleBehavior: "promptRequired"`, so a completion race falls back to
ordinary prompt dispatch instead of creating an untracked adapter-owned turn.
Accepted input is removed from the queue even if stopping advances the
generation while the request settles, preventing a delivered steer from being
replayed on resume. Queue-to-transcript handoffs publish the consumed input
together with its committed transcript entries: each
`transcript_message_committed` delta carries the entry and the remaining queue,
so steering and batched sends never expose a partial state between removal and
commit. The chat keeps each message row mounted and briefly collapses its queued
controls when dispatched, respecting reduced-motion preferences.

Codex uses native `turn/steer` without cancelling the current turn. Claude's
native steering may pre-empt generation or background a foreground tool; neither
provider promises delivery at a specific tool boundary. The action tooltip
explains that active work may be redirected.

The workspace and quick-chat composers use prompt ownership for their queue
placeholder and send-button label; background activity keeps the stop control
available for active agent work without implying that the next message must
wait.

Startup and required configuration must complete before submission. Workspace
initialization/manual-resume policy, per-session dispatch serialization and
stop/generation fences still apply. The prompt slot is rechecked after
auto-start; another caller may have acquired it while startup was awaited. A
stopped runtime can auto-resume through the existing launch policy; being
stopped is not permission to bypass setup or a failed exact resume.

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
follows the last provider message timestamped at or before it. Claude and Codex
turns use the configurable Turn limit, defaulting to unlimited. Startup/stop
incarnation fences protect runtime replacement and shutdown.

Provider protocol schemas are maintained by upstream adapters. Keep focused ACP
client contract tests when upgrading either dependency, including saved-session
resume, plan approval, questions, native subagents, and reviewer permissions.

### Codex accounts

Failed Codex runtime and account probes show retry/restart guidance rather than
raw command paths or quota-exhaustion advice. Runtime resolution failures retain
update/reinstall guidance. Auto selection still uses healthy candidates when
another probe fails; if no candidate remains and any probe failed, capacity is
unknown and the error asks the user to retry. Identity-binding failures retain
sign-in or duplicate-account cleanup guidance; caller cancellation remains
distinct from provider unavailability. Excluded overlapping native readings do
not affect the remaining accounts' error. Provider warnings and onboarding show
the server's recovery guidance. Confirmed exhausted accounts retain the capacity
error. These messages do not change probe deadlines or add retries.

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

Launcher thinking, planning and access options come from a disposable ACP
session. The durable capability cache described above keeps successful
observations available while refreshing in the background. Keys distinguish
provider, requested model, and explicit Codex account or Auto preview. Fresh
saved effort defaults are applied to cloned results. Cached reads do not probe
Codex accounts; account selection and validation run only for cold discovery or
background refresh. Auto retains the last successful preview rather than
tracking every usage-based account change. Actual session startup still selects
and validates its account and applies native model/configuration checks. Cold
entries await discovery when admission is available, or return a busy error when
saturated. Process admission remains charged until both the native child and
protocol pipes close. Cache refreshes respect the same admission limit and do
not run on a timer.

The `session-launch-options` logger records stage durations for settings,
account resolution, options lookup and the overall request. Native probes also
record initialization, session creation, model selection and cleanup durations,
including failures, so slow account checks can be distinguished from adapter
startup. Timing and background-refresh warnings omit raw provider errors and
subprocess diagnostics.

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
persistence are pending. During provider history load, transcript events already
covered by hydrated history are suppressed before entering this buffer. Raw
logging and native work tracking still receive the replay, while configuration,
commands, usage, plans, notices and subagent state continue through startup.
Suppressed transcript updates still maintain translator bookkeeping, including
compaction identities. The tracker's replay-end marker ends early filtering
before the load response when supported; otherwise load completion ends it.
Native child replay retains all transcript updates within its existing limits
but emits only creation/completion invalidations until replay finishes, avoiding
one buffered invalidation per child output chunk. Live invalidations continue
normally afterward. Suppression ends before a failed load starts a replacement
conversation. Overflow cancels startup and terminates its candidate; it never
installs a runtime with a silently truncated transcript. Rollover fencing
rejects further reconciliation after overflow, and a later startup can retry.

### Session prompts

ACP init/load uses the provider's built-in instructions; Factory Factory does
not supply a custom system prompt. Task prompts are sent as ordinary session
messages:

- Issue starts: `src/shared/issue-start-prompt.ts`, shared with the editable UI
  preview. It asks the agent to fetch and address the linked GitHub or Linear
  issue, then create a PR with a closing reference. The concise handoff quotes
  the URL and marks fetched content as untrusted; issue bodies and detailed
  workflow instructions are not embedded. Repository guidance defines
  implementation and verification. Backend fallback prompts use the stored issue
  URL (or derive a GitHub URL from repository metadata), without fetching issue
  content. The read-only `get_linear_issue` workspace MCP tool fetches the
  linked Linear issue on demand through `workspace.get` and `linear.getIssue`,
  using backend-held project credentials. It accepts no workspace/project/issue
  overrides and returns only issue fields, treating provider text as untrusted
  data.
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

The durable event launch consumer composes `createEventWorkspaceOnce` and
`createEventSessionOnce` with reserved IDs from an admitted event run. They
create their entity and retained launch origin in one transaction. Workspace
origins survive workspace, run and project removal; session origins survive
session and workspace removal. A retained origin without its live entity blocks
recreation, including deletion before run linkage. Archived workspaces and
projects also block creation/reuse. Generic interactive, child and periodic
creation keeps its existing behavior.

The agent-definition owner exposes `readEventExecutionBinding` and
`freezeEventExecution`. Freeze checks the current worker/attempt, lease,
reserved IDs and PENDING delivery identity, then stores immutable effective
execution without changing admitted snapshots. The original reserved message ID
stays fixed; a later explicit retry can rotate the delivery's message ID and
send-attempt ID. Generation checks fence earlier callers.

New event runs freeze access from the saved workspace permission preset for both
providers. Non-interactive execution does not grant extra permissions; explicit
YOLO remains honored. Recovery reuses the frozen access intent rather than
reading newer defaults. Startup validates that the provider supports and applies
that intent, including Claude’s `auto` / `acceptEdits` compatibility.

Launch orchestration selects a Codex account under `withAccountReservation`,
freezes its ID before session insertion, and uses that same ID on recovery or
fails. Session creation validates that exact account via the application graph's
account service without selecting Auto or entering a second reservation.
Disabled, missing or unauthenticated frozen accounts do not fall back. Origins
store account IDs and a strict versioned execution intent, never credentials.
The first session insert checks the run's frozen execution and reserved
workspace/session/project identity in its transaction through a narrow read-only
integrity check. Session reuse compares that original intent rather than mutable
model/launch metadata. Initial dispatch pins the origin's settings even if a
human has changed ordinary conversation settings.

Event sessions use `event-agent` and explicit `non_interactive` intent, with
ratchet disabled at workspace creation. They do not inherit periodic Codex YOLO
permissions. These APIs neither initialize a provider nor dispatch a prompt; the
consumer composes strict setup/restart and observed initial dispatch around
them. Monitoring and operator recovery, plus activation and native capability
validation, remain prerequisites for enabling saved agents.

The strict event workspace initializer shares the ordinary initializer's
per-workspace queue and worktree preparation. It validates the reserved session
and current run claim, then runs factory setup and project startup scripts
without the ordinary auto-message or first-IDLE-session path. Workspace writes
recheck the claim, lease, retained origins and live entities in the workspace
owner's transaction. An aborted or superseded initializer cannot publish a late
worktree or READY. The caller owns run linkage, lease renewal and eventual
initial dispatch; the initializer does not enqueue or send a prompt.

State publication revalidates the claim and emits the current row; unrelated
metadata writes cannot suppress READY, and notification failures cannot undo a
validated commit. Rejected observer promises are diagnosed without awaiting
observers or delaying later subscribers. A missing retained READY worktree
becomes FAILED under the same claim and path fence, preserving its path and
provenance for inspection. Recovery must not infer safe reinitialization from
PROVISIONING alone: the consumer preserves uncertain physical-work evidence and
retains capacity until current cleanup proof permits reset. Persisted PIDs never
grant process ownership.

Event setup has a fifteen-minute deadline. Uncancellable Git work remains owned
until it drains; timeout does not abandon its promise. Abort and script timeout
stop the current owned setup process group and distinguish confirmed cleanup
from UNKNOWN, including while output and PID writes drain after foreground exit.
Git's absence preflight does not reserve a path or prove ownership of later
physical work. A successful creation result permits safe cleanup only under a
fresh durable claim and caller ownership, checked independently of cancellation.
If creation rejects without that result, remaining disk or registration effects
are retained as UNKNOWN. CONFIRMED requires positive absence on disk and in Git
under the unchanged, available canonical base identity. Inspection failure is
UNKNOWN. Unknown cleanup forbids retry or capacity release. Ordinary nonzero
script exits still produce READY with a warning, and successful scripts may
retain background dev servers. Invalid configuration and execution errors return
explicit failures. Event initialization does not create an unattended terminal
or send a Linear status update; a user can open a terminal afterward. Ordinary
interactive, child and periodic initialization retain their policies.

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
effect after gate cleanup. Bulk shutdown does not run per-session stops, which
own queue retries, so the next shutdown step (`SessionDispatchService.shutdown`)
cancels pending retries, refuses new ones and waits for retries already
dispatching before the database closes.

Queue execution belongs to the single `SessionDispatchService` configured in
`session-services.ts`. Initialization, notification delivery, lifecycle queue
recovery, and prompt completion use its dispatch capability directly. The chat
registry's dispatch and manual-resume callbacks reach that same instance through
the transport-owned chat router. Lifecycle generation, delivery claim, and
transcript-commit ownership remain with their existing services.

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

The session capsule's `service/` directory is grouped by sub-domain. Imports
point up this table: code imports from its own row or earlier rows, never later
ones. The barrel `index.ts` and `interceptor.bridge.ts` sit below every row. Two
older edges remain: `store/` and `voice/` publish through the root
`session-event-bus`, and `dispatch/` reuses the chat attachment helpers.

| Directory                                                | Owns                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `acp/`, `store/`, `logging/`, `metadata/`, `voice/`      | ACP runtime; in-memory session store; trace logs; workspace metadata generation; voice narration                                     |
| `providers/`, `archive/`                                 | Account-wide model catalogs and plan usage; closed-session transcripts                                                               |
| root (`session-domain.service.ts`, `bridges.ts`, others) | Domain state, bridge interfaces, resume fence, provider error messages                                                               |
| `data/`                                                  | `SessionRepository`, stored launch settings and startup intent, provider history loading and hydration                               |
| `config/`                                                | `SessionConfigService`, config commit authority and mutation queue, permission presets, launch options, startup configuration        |
| `event-agent/`                                           | `EventSessionAuthority`, event fences, event startup guards                                                                          |
| `delivery/`                                              | Notification and PR background delivery, PR receipts and discovery                                                                   |
| `events/`                                                | `AcpEventProcessor`, permission requests, sub-agent events, work state                                                               |
| `lifecycle/`                                             | Gate, scope, startup, termination and runtime-exit coordinators, workflow finalizer, context, lifecycle events, the lifecycle facade |
| `prompt/`                                                | `SessionService` prompt sends, child-workspace prompt context                                                                        |
| `dispatch/`                                              | Queue dispatch                                                                                                                       |
| `chat/`                                                  | Chat commands, session load                                                                                                          |
| `composition/`                                           | Composition root (`session-core-services.ts`, `session-services.ts`)                                                                 |

`SessionConfigService` is a facade over four owners. `SessionConfigWriter`
accepts, persists and publishes native configuration writes, and every other
owner writes through it. `SessionConfigReader` projects live or stored
configuration. `SessionStartupConfiguration` applies launch intent to a new
runtime. `SessionConfigMutations` applies live and stopped-session edits.

Startup, termination, runtime exit, notifications, context, and workflow
finalization each have one coordinator or service.

| Responsibility        | Owner                                              | Reconciliation point                                      |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Startup               | `SessionStartupCoordinator` (`lifecycle/`)         | Persisted `RUNNING` state                                 |
| Termination           | `SessionTerminationCoordinator` (`lifecycle/`)     | Persisted idle/stopped state                              |
| Runtime exit          | `SessionRuntimeExitCoordinator` (`lifecycle/`)     | Terminal status and unexpected-exit lifecycle history     |
| Notifications         | `SessionNotificationDeliveryService` (`delivery/`) | Transcript plus delivered evidence                        |
| Context               | `SessionContextService` (`lifecycle/`)             | Operational precondition; no durable-state reconciliation |
| Workflow finalization | `SessionWorkflowFinalizer` (`lifecycle/`)          | Idempotent workflow completion                            |

`SessionScope` (`lifecycle/session-scope.ts`) owns the lifetime of per-session
in-memory state. Collaborators register disposers in the composition root, and
the coordinators run the scope's stages instead of listing collaborators:

| Stage           | Run by                                   | Disposers                                                                                                                                                                        |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginTeardown` | Stop and runtime exit, first             | Prompt-turn completion, queued ACP prompts                                                                                                                                       |
| `quiesce`       | Stop, before the runtime stops           | Streaming and replay state, pending permissions                                                                                                                                  |
| `settle`        | Stop and exit, after orphan finalization | ACP event state; permissions on exit                                                                                                                                             |
| `completeStop`  | Every stop, before the reservation ends  | Dispatch claim, steering, retries, mail claims                                                                                                                                   |
| `forget`        | `session_permanently_deleted`            | Configuration, observed-empty, queued PR delivery tokens, cached provider history, session store and initial message, transient archive marker, dispatch state and manual resume |

Stages run disposers in registration order and log, rather than propagate, a
disposer failure. Every stop caller (WebSocket, tRPC, admin, orchestration)
therefore resets dispatch state while the stop reservation still blocks new
dispatch. Every durable deletion reaches `forget`: session deletion through the
session data service or repository, and workspace deletion, which forgets each
cascaded session after the rows are gone. New per-session state should register
a disposer instead of adding a call to a coordinator.

When changing lifecycle behavior, keep these boundaries intact: coordinators and
services own their named responsibility and reconciliation evidence where
applicable; context supplies operational inputs. The lifecycle facade delegates
public operations and the session composition root wires the owners.

### Fencing primitives

Per-session work captures a token and re-checks it after each await. Pick the
narrowest fence that matches what the work must yield to. Paths are relative to
`src/backend/services/session/service/` unless they start with `src/`.

| Fence                                                         | Owner                                                              | Fences                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Lifecycle generation (`getGeneration`, `isGenerationCurrent`) | `SessionLifecycleGate` (`lifecycle/session-lifecycle-gate.ts`)     | Prompts, initial sends and event-owned work vs. stop, shutdown or an unestablished startup lease ending |
| Stop-only fence (`hasStopSince`)                              | `SessionLifecycleGate`                                             | Queue dispatch, steering and mail retries vs. explicit stop or shutdown only                            |
| Stop and shutdown reservations (`isSessionStopping`)          | `SessionLifecycleGate`                                             | Concurrent stops; startup and dispatch while a stop or runtime stop is in flight                        |
| Startup lease (`establishStartup`, `assertStartupAllowed`)    | `SessionLifecycleGate`                                             | Startup continuations after a stop                                                                      |
| Supervisor stop generation                                    | `AcpRuntimeSupervisor` (`acp/acp-runtime-supervisor.ts`)           | In-flight client creation vs. any runtime stop, including ungated ones                                  |
| Runtime incarnation and current handle                        | `AcpRuntimeSupervisor`                                             | Events, exits and prompt timeouts from a replaced process                                               |
| Observed-stop ownership (`canStopTarget`)                     | `AcpObservedStop` (`acp/acp-observed-stop.ts`)                     | Physical stop or cleanup of a replaced handle or provider source                                        |
| Prompt readiness and configured handle                        | `AcpPromptReadiness`, `acp/acp-configured-handle.ts`               | Prompts and config writes before configuration completes or after replacement                           |
| `SessionCallerGuard` (`check`, `assertCurrent`)               | Caller (`bridges.ts`; built by orchestration retry authority)      | Dispatch, config and prompts vs. loss of the caller's authority                                         |
| Event authority, `EventSessionFenceError`                     | `EventSessionAuthority` (`event-agent/event-session-authority.ts`) | Event-initial delivery and late durable writes vs. cancel, close or ownership change                    |
| `WorkspaceInitFenceError`                                     | `src/backend/lib/workspace-init-fence-error.ts`                    | Dispatch vs. workspace initialization policy (message stays queued)                                     |
| Event-owned work windows                                      | `EventOwnedWork` (`lifecycle/event-owned-work.ts`)                 | Work proofs vs. a later prompt, pending request, or stop and restart                                    |
| Dispatch claim token                                          | `SessionDispatchClaim` (`dispatch/session-dispatch-claim.ts`)      | Concurrent dispatch per session; stale releases                                                         |
| Notification dispatch claim and mail wake claim               | `SessionNotificationDeliveryService`                               | Duplicate or quarantined notification sends; stale wake settles                                         |
| PR delivery tokens (`validate`)                               | `SessionBackgroundDeliveryService`                                 | Queued PR updates from an old binding revision                                                          |
| Resume fence                                                  | `sessionResumeFences` (`session-resume-fence.ts`)                  | User resume and input submission vs. user stop or runtime failure                                       |
| Config commit token and mutation queue                        | `SessionConfigCommitAuthority`, `SessionConfigMutationQueue`       | Superseded config commits; config edits across runtime replacement                                      |
| Store guard (`captureStoreGuard`)                             | `SessionDomainService`, `store/session-store-registry.ts`          | Dispatch and steering writes into an evicted or replaced store                                          |
| Provider history fence                                        | `SessionDomainService`, `lifecycle/session-startup-history.ts`     | History replay after store replacement, suspension or provider change                                   |
| Application update admission                                  | `src/backend/services/application-update-admission.service.ts`     | New dispatch and starts once an application update closes admission                                     |
| Workspace activity generation                                 | Workspace activity service (`markSessionRunning`)                  | A stale idle mark clearing a newer run                                                                  |

Dispatch uses the stop-only fence because a startup lease that ends without
establishing a runtime (a failed start, or `ensureSubagentBrowseSession`
returning `false` for a session without native sub-agent browsing) deletes the
lifecycle generation. A dispatch that captured it would otherwise return with
its message still queued and no retry. The supervisor keeps its own stop
generation: it also advances for runtime stops that never reserve through the
gate (failed-startup cleanup, observed and targeted stops), and ACP internals
cannot import the lifecycle gate.

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
snapshots include the current task list, so hydration clears stale client state
when no list exists; queue deltas leave the client's task list untouched.
Replacing a provider's archived history also clears its task snapshot.

## Provider sub-agents

Provider-initiated sub-agents are session-scoped, read-only, and provider-owned.
Factory Factory projects their native ACP metadata and transcripts into the
Subagents panel through its session-scoped tracker. Clicking a single running
sub-agent in the main chat opens its transcript tab directly, without expanding
a list. With multiple running sub-agents, the count expands an inline list;
selecting one opens its transcript tab directly. Completed sub-agents remain in
Subagents. The inline list deduplicates overlapping provider pages and retains
pagination and Retry controls when later pages are unavailable. The Subagents
panel's stored key remains `agents`; child-workspace access remains available
for parent workspaces. The count shows the assigned icons of up to three active
sub-agents in creation order; larger groups keep the full count without adding
more icons. Until all summary pages load without errors, the count remains
visible without placeholder agent icons. The Subagents list, lifecycle rows, and
sub-agent tabs share twelve nature icons claimed in creation order (with agent
ID breaking ties). Each sub-agent claims the lowest available icon; completion,
failure, cancellation, or interruption releases it for later agents. Lifecycle
timestamps reconstruct claims after reloads so every surface uses the same
assignments. Provider revisions to lifecycle timestamps or resumed threads can
change reconstructed assignments. Unknown lifecycle times conservatively retain
claims. More than twelve overlapping agents use distinct numbered badges; those
slots can also be reused after completion. Tabs preserve the assigned icon color
and pulse while starting or running. Unknown creation times sort last. Its
header counts active (starting, running, or waiting) sub-agents; terminal agents
remain under the separate collapsible Completed count. The panel automatically
loads all summary pages before showing the active count, so children on later
provider pages are included. A page failure keeps loaded rows visible and offers
Retry without displaying a partial count. Repeated provider cursors stop
automatic pagination and offer the same recovery instead of repeatedly fetching
the same page. Sub-agent tabs also load all summary pages, even after finding
the selected child, so earlier-created agents on later pages receive the same
icon ordering. Restored transcript selection uses the same cursor guard. Live
sub-agent events invalidate list queries by parent session, without cursor or
page-size fields, so infinite-query caches refresh newly spawned and completed
children without a page reload.

The chat timeline projects provider creation and completion timestamps into
separate, muted sub-agent start and finish rows. Failure, cancellation, and
interruption retain their own labels. In workspace-detail chat, start and finish
rows open the corresponding sub-agent transcript tab, including stopped agents.
Both workspace-detail and Quick Chat reconstruct the rows from provider metadata
when history reloads; unknown timestamps are not invented. Native ACP replay
without provider timestamps retains sub-agent summaries and transcripts for
browsing but leaves lifecycle times unknown, so reopening a workspace does not
append historical starts and finishes as new activity. Live native events still
use their observation time. If a request fails or the provider repeats a
pagination cursor, chat keeps known rows visible and offers Retry. Adjacent tool
activity stays collapsed by default as muted summary rows; expanding a summary
shows chronological calls with input and output available on demand. Failure
counts and warning icons appear only while the group is expanded; collapsed
summaries retain their activity icon (or running indicator).

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
Factory. Stopped Codex sessions can restore a browse-only runtime to read native
history without sending a prompt. Other stopped providers may not expose that
history. When browsing is unavailable, the Subagents panel explains the
limitation instead of rendering a blank tab; this is distinct from a supported
session with no subagents.

## Child workspaces

A parent workspace can spawn child workspaces (in any project) via MCP tools
exposed to the agent (`spawn_child_workspace`, `send_message_to_child`,
`archive_child_workspace`, `list_projects`). Children report back via
`send_message_to_parent`.

Child-workspace MCP requests connect to localhost when `BACKEND_HOST` is unset
(the backend then binds `127.0.0.1`, plus `::1` where IPv6 is available) or is
an IPv4 or IPv6 wildcard, including equivalent compressed IPv6 spellings.
Explicit bind addresses remain the connection destination.

Messages are persisted as workspace inbox mail. Their bodies are never injected
automatically into an agent conversation. Agents receive a coalesced, body-free
“you have workspace mail” signal, inspect summaries with `list_mail`, retrieve
selected content with `read_mail`, and explicitly acknowledge IDs with
`ack_mail`. The workspace right panel exposes the same inbox to users. Chat
renders standalone mail signals as compact, collapsed envelope rows, hiding
agent instructions and receipt markers. Expanding a row loads the current inbox
and lets users open message bodies; the revision labels the notification rather
than a historical inbox snapshot. Reading and acknowledgement keep the same
explicit inbox behavior. Live and historical parent/child inbox notifications
also collapse to envelope rows with expandable message text. Combined user
prompts retain their full text so user instructions remain visible.

`PROGRESS` mail is quiet and can supersede older progress for the same sender
and task key; explicit task revisions prevent late progress from replacing a
newer revision. `MESSAGE`, `BLOCKER`, `QUESTION`, `COMPLETION` and `INSTRUCTION`
mail are actionable. Acknowledgement is separate from reading, provider wake
delivery, and completing the underlying task. Existing delivered notifications
migrate as acknowledged; pending notifications remain available as mail.

Lists default to 20 summaries (maximum 50), each with a preview of at most 160
UTF-16 units. Selected reads default to an 8,192-unit total body budget (maximum
16,384) across at most 20 IDs. Previews and chunks preserve surrogate pairs.
Long messages return continuation offsets; a one-unit budget that cannot fit the
next character reports an explicit error. The UI enables acknowledgement after
the complete selected body has been read. Superseded progress is hidden by
default and available through the explicit history filter. Read and
acknowledgement operations are scoped to the recipient workspace. Inbox previews
and bodies require trusted-local access, as do acknowledgement and explicit wake
retry. The MCP tools bind the recipient to their launch context.

The Inbox tab, board cards and sidebar rows show unread counts from one shared
project query rather than loading each workspace's messages. Counts match the
inbox's unread filter: only mail with no read, acknowledgement or supersession
timestamp is included, including current progress. The trusted-local endpoint
returns counts only, covering all inbox pages. It performs no read or
acknowledgement writes. Counts refresh every 15 seconds and after explicit UI
reads or acknowledgements; merely opening Inbox or viewing a board does not mark
mail read. Display counts cap at 99+, while accessible names retain the full
total.

A durable revision and fenced wake claim keep one outstanding notification per
workspace. New arrivals do not queue repeated prompts while a signal remains
outstanding. Acknowledging selected mail at an observed revision releases its
wake latch without acknowledging newer arrivals. Failed/full-queue wake claims
remain retryable. Supported native steering delivers the small signal during a
busy turn; unavailable steering retains the queued fallback for turn completion.
Both queued prompts and native steering persist an uncertainty fence before
provider submission. A failure after possible provider acceptance leaves a
durable ambiguous wake instead of replaying it automatically, including after
restart. The inbox exposes an explicit **Retry mail notification** action with
notice that it may notify the agent again. Unresolved delivery uncertainty
requires that explicit action. A valid late provider reply proving no injection
can instead disarm its exact claim and resume normal recovery under the current
session and workspace guards. Reading mail and acknowledging selected IDs remain
independent. Explicit startup assignments always precede recovered mail signals.

Max workspace depth is 1 — children cannot have child workspaces.
Provider-native subagents are a separate facility.

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

- Orchestration:
  `src/backend/orchestration/workspace-lifecycle/workspace-children.orchestrator.ts`
- MCP entrypoint: `src/backend/mcp/workspace-mcp-server.ts`
- Session MCP spawn configuration:
  `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`

## Quick actions

Workspace quick actions are markdown-driven from `prompts/quick-actions/`
(frontmatter metadata + prompt body); that directory is their only source. The
composer's ⚡ **Quick actions** menu (`Cmd/Ctrl+Shift+A`) lists the agent
actions and offers **Run in this chat**, which sends the prompt into the current
chat, or **Run in new chat**, which creates a chat named after the action and
auto-sends the prompt once it is ready. "Run in new chat" is disabled, with the
reason shown, while a new chat can't start (workspace setup, the active chat
limit, the chat list still loading, or a chat being created or closed).
Composers without a workspace chat collection offer only "Run in this chat". The
workspace header's **Create PR** runs the `create-pr` action in a new chat.

The active chat limit (`MAX_SESSIONS_PER_WORKSPACE`) counts `RUNNING` and `IDLE`
sessions, except finished adversarial reviews: an `adversarial_review` session
that is `IDLE` and has started a provider session keeps its transcript but no
slot. A review created but not yet started still counts. Only a `RUNNING` review
blocks another review of the same PR, so a finished review can be run again. The
limit is checked when a session is created, not when it resumes, so continuing
the conversation in a finished review can briefly put the workspace over the
limit until that turn ends.

`prompts/` is copied into `dist/` on build and packaged alongside the unpacked
Electron backend, so a new prompt file ships without a code change.

## Desktop backend process

The desktop app runs the backend in an Electron utility process, not in Electron
main, so synchronous SQLite work, agent streams and terminals cannot freeze the
window or menus. `electron/main/server-manager.ts` forks
`src/backend/electron-utility-entry.ts` and passes the database, migrations,
frontend and log paths through the child environment. The child backs up the
database when migrations are pending, runs them, starts the server, and posts
`ready` with its URL or `error` over `process.parentPort`; startup that takes
longer than two minutes is killed.

Electron main opens the window as soon as the app is ready, showing a
self-contained loading page (`electron/main/loading-page.ts`, a `data:` URL with
no scripts or remote resources) while the backend starts, then loads the app
URL. A failed start destroys the loading window before the startup error dialog
and quit; closing it during startup stops the backend like closing any last
window, and the app URL is never loaded into a closed window.

The app window never opens child windows. `target="_blank"` links and
`window.open` calls open in the system browser or mail client, even for app
URLs, because a child window would inherit the preload bridge. Top-level
navigation and redirects that leave the loaded app's origin are cancelled and
opened externally. Only `http`, `https` and `mailto` URLs reach
`shell.openExternal`; other schemes are blocked
(`electron/main/external-links.ts`).

The native app menu exposes Settings, New workspace, Search and Toggle sidebar
through the renderer shortcut registry, preserving the same actions as keyboard
and command search. Commands wait for the trusted renderer subscription, so
opening a window or starting the backend does not lose the first menu action.
Standard editing and window controls remain available; Reload and DevTools are
development-only menu items.

The desktop shell (`electron/main/desktop-shell.ts`) saves normal window bounds
and maximization in `window-state.json` under Electron's userData directory on
close. It validates restored JSON and clamps bounds to the current display work
area, so removed monitors do not strand the window. Missing or corrupt optional
preferences do not block startup. The minimum window size is 640 × 480 (bounded
by the display work area). The loading window uses system appearance until the
renderer syncs the selected application's background, including theme presets
and custom overrides; trusted IPC accepts only an opaque hex color.

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
Subagents panel expose an icon-only Stop action. Each action has its own
disabled spinner until live provider updates remove the work or withdraw its
capability; request acknowledgment does not invent completion. Failures use a
toast and allow retry. Pending attempts and their original deadlines survive
list/panel remounts, and confirmation waiting is bounded to 15 seconds.
Disconnecting hides controls, and stopping a row remains separate from selecting
its transcript.

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

The `dispatchAgentInitialPrompt` API targets the reserved session and sends one
initial turn using its frozen execution and account binding. Its caller supplies
a synchronous current-claim guard. Human input stays in the ordinary queue
during setup and delivery. Queue reset, retry, manual resume, steering, direct
startup and configuration edits cannot remove the durable fence. The event
launcher freezes execution, creates and links the reserved workspace/session,
then uses strict owned initialization before this API. Saved agents remain
unactivatable until operator recovery, lossless predelete result capture, native
capability validation and UI gates exist.

AgentRun.launchPreparation is a versioned physical-operation marker. A null or
SAFE marker with PENDING delivery can resume with the same identities. SETUP or
STARTUP is persisted before physical work; only a successful setup or confirmed
cleanup makes it safe again. Hard restart in those operations with PENDING
delivery produces held preparation/cleanup uncertainty: PENDING still proves
that the initial task was unsent. Once delivery is SENDING or ACCEPTED, recovery
retains delivery uncertainty and never automatically resends, even if STARTUP
remains marked. FINISHED initial outcomes remain immutable for later run
settlement. Marker-before-effect and cleanup-before-marker crash windows can
conservatively require operator resolution. Existing script PID/output and
capacity are retained while cleanup is uncertain; persisted PIDs are never
signalled. Git cleanup requires positive filesystem and canonical registration
absence even when the legacy removal promise resolves.

The targeted `interruptEventInitial` capability records the requested lifecycle
cause without ordinary user-stop finalization or clearing queued human input.
Monitoring supplies the exact expected attempt and runtime source; replacement
or unavailable source blocks the action, including after awaited owner reads.
Targeted ownership-read failure or timeout fails closed; ordinary explicit stop
and global shutdown keep their separate physical-cleanup fallback. Cleanup of a
finished initial failure waits for ordinary follow-ups and known agent work to
finish. Initial dispatch cancellation shares the existing evidence deadlines and
fences late observations; it does not close global authority. Failure and abort
cleanup carry the launch ownership guard through handoff, stop ownership/fence
reads, evidence publication and final disposition. Cleanup ownership is separate
from the aborted input signal, so a current owner still performs its shutdown
stop. Revoked cleanup cannot invalidate a replacement; already-started physical
cleanup remains joined before its launch releases physical-stage tracking.
Already-started observation writes remain tracked for final session teardown.
Setup cancellation joins actual Git operations and script cleanup directly, so
uncancellable Git may outlive the setup deadline while retaining ownership.
Durable reads and output/PID persistence use the existing bounded evidence
drain; expiration closes the launch guard permanently. A late read cannot start
physical work or a new write, and any already-started physical operation still
drains directly. A settled UNKNOWN setup cleanup has no reusable process-control
handle in the launcher; missing local state is never used as termination proof.

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

The dormant runtime exposes transport-neutral inspection and explicit RESOLVE,
ABANDON and RETRY actions. Every action checks project, run, worker generation,
attempt generation and current message/send identities. The consumer permanently
fences the matching initial operation, including admission awaiting a durable
read, before targeted cleanup. This does not abort into a second untargeted stop
or revoke a replacement. Active human follow-ups block recovery cleanup.

Resolution requires correlated strict local stop plus a current stopped-work
window and complete child-history coverage. RESOLVE retains the RUNNING slot for
a later decision; ABANDON closes it with an explicit decision separate from the
provider outcome. RETRY retains capacity continuously and preserves the run,
workspace, session, frozen account/input, original initialMessageId,
setupStartedAt and inherited attemptCount, including an exhausted budget. It
rotates only the current send identities and attemptGeneration, reuses the READY
worktree without rerunning setup, and replaces the consumer's old operation.
Deleted or unavailable resources block retry. Inspection includes directory
existence and read/traversal access in `retryResourcesAvailable` and reports a
retry-specific `retryBlocked` resource reason, separate from common proof
blocks. An unavailable retry directory does not block RESOLVE or ABANDON. Retry
checks resources before targeted stop and again at final transaction validation;
losing the directory during the write rolls back with `RESOURCES_UNAVAILABLE`.
Known child work, unknown child history and settled UNKNOWN setup cleanup have
no supported recovery action.

Saved resolution JSON does not restore lost live coverage. Both a later action
and the rotated attempt's startup require the old stopped-work window to remain
valid. A restart between rotation and startup can therefore leave the new
attempt unsent and blocked. Ordinary startup/send remains allowed after a
finished initial turn, but invalidates prior proof; a pending retry uses the
existing durable initial-delivery fence. Only an independently resolved previous
attempt permits a new tracking window after history replay. Recovery uses the
same final synchronous proof check and asynchronous engine-commit limitation as
settlement.

Normal settlement requires the current initial runtime's live tracking window,
established before its send, and zero in-flight prompts, interactive requests,
active goals, native children and non-shell agent tasks. Shell/dev-server-only
work does not retain capacity. FF child-workspace creation is retained by its
workspace owner, including through archive and deletion, and holds parent
capacity independently of native tracking. The current ordinary child lifecycle
cannot supply positive child-work cleanup proof: archive, deletion, IDLE and a
successful legacy stop return cannot resolve that hold. Recovery and UI must not
advertise those operations as resolution; supported positive child cleanup still
requires implementation before activation. Missing tracking, replay, source
replacement and restart without live coverage remain unknown; history inspection
never starts a provider. A newly created event-workspace origin marks complete
child-history capture in its creation transaction. Historical origins remain
unknown; importing a matching workspace revokes that coverage even when the
workspace already exists. Backfilling surviving children retains holds but does
not certify an empty history. A terminal failure/cancellation, unexpected exit,
timeout or workspace removal also needs correlated strict runtime-stop evidence.
Event runs freeze the global turn limit at launch and use the durable send
timestamp for their deadline. Both providers default to unlimited, including
historical runs without a saved limit; run history advertises no deadline in
that case. Ordinary turns read the setting when each prompt starts. SHUTDOWN
uncertainty remains reserved for recovery and does not fall through to timeout.

The owner transaction persists the work proof and terminal result together,
checking worker, send attempt and current source. Settlement linearizes at its
final synchronous live-token validation after all awaited reads and mutations.
Observed work/source/lifecycle changes before that check roll back the write.
The database engine's asynchronous commit remains a gap: this is a contract for
supported FF-tracked work, not universal containment of future native activity
or remote effects. Tracker updates continue normally throughout persistence.

Observed PR links are unioned into bounded run results while work remains held.
Successful quiescent work becomes PR_CREATED when links exist; failed or
cancelled initial work preserves its outcome and links. Workspace deletion
captures valid still-persisted PR associations, including detached links, in the
same SQLite write transaction as the cascade. Attachments committed first are
included; a concurrent attachment cannot commit against the deleted workspace.
Capture failure rolls back deletion. This result-only update also supports
terminal runs without a live lease and preserves their status, summary,
completedAt, provider outcome and explicit recovery decision. The validated
union filters invalid links and retains at most 20 links across retries and
deletion; it is not an unbounded history. The required capture port is wired by
orchestration and deletion fails closed when unavailable. Capturing results or
deleting a workspace never proves work resolution or releases held capacity.
Ledger pruning and trusted-local operator transport are implemented. Operator UI
and the child-work product decision remain activation prerequisites. Monitoring
never auto-archives a workspace.

Event runtimes use an owned POSIX process group. Strict stop confirms
LOCAL_RUNTIME_GROUP_STOPPED only after observing that group disappear. A
permission-uncertain probe after a successful owned signal may wait within the
existing stop deadline, but does not permit escalation or count as absence.
Initial probe errors, signal errors and lost ownership remain unconfirmed.
Stopped-work proof also requires the retained stop source to match the original
source; every new runtime registration invalidates that retained proof. Adapter
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

### Setup retry and event initial authority

Generic workspace setup retry reuses `EventSessionAuthority`'s initial-operation
admission map and injected durable fence reader. Its captured retry guard checks
both exact durable attempt identity and synchronous local currentness across
startup and the final provider prompt boundary. Availability DTOs and retained
history are explanatory reads, not execution permits.

An ordinary session starting after a workspace reaches READY does not by itself
block manual event recovery. Existing READY resource checks and reserved-session
runtime creation/drain proofs protect the event attempt; setup retry does not
add a workspace-wide activity ban or new process-stop authority.

Startup carries the same captured caller checks through recovered-notification
queue dispatch, queue-triggered client creation, configuration and the common
initial-prompt branch. A guard wait cannot switch the operation to a replacement
runtime. Runtime identity and the paired workspace retry caller fence are
checked synchronously at the provider effect; ordinary ready prompts retain
their immediate dispatch. A rejected, unsent retry restores only its own
runtime's idle state.

Paired workspace retry startup cleanup stops only its captured candidate.
Managed runtime exits retain queued input; explicit session stop still clears it
before stopping the runtime, and unmanaged exits retain their existing queue
reset. Headless stores with queued work remain in memory until consumption,
explicit stop or shutdown; empty inactive stores can still be evicted. Recovered
durable notifications stay pending when a guarded dispatch is rejected.

A prepared PR delivery carries its captured rejection cleanup through the
dispatch caller's final authority check. Rejection drains that exact claim
before returning; cleanup does not look up a replacement delivery by
queued-message ID.

Startup callers that own only an asynchronous authority check carry that check
through recovered-notification dispatch. A synchronous caller fence is optional
on the session dispatch contract; workspace retry guards still require their
local fence. Async-only dedicated bootstrap retains its existing full-stop
cleanup: a rejected dispatch leaves durable notifications pending, but that
cleanup may clear in-memory input. Explicit session stop clears queued work both
on entry and after physical cleanup, while its stop reservation remains held, so
input arriving during the stop is cancelled. Captured PR failure settlement
compares the attempt as well as the existing binding and recipient identity; a
failed settlement cannot pause a replacement binding.

Queue cleanup and queue-length reads do not create or activate a session store.
This keeps post-stop cleanup from reviving a permanently deleted transient
ratchet session, including while a viewer remains open, and preserves
rejection-only store expiration. Existing stores still clear queued work and
publish pending request/queue updates normally.

Resuming exhausted PR delivery allowance can reset an active claim's attempt
count. Its old captured settlement then fails the attempt fence, but owner
cleanup releases the active mapping. A subsequent existing idle or regular-poll
wake performs receipt recovery: delivered receipts settle, absent receipts can
reclaim under the current binding, and unavailable receipts pause explicitly.
The nested completion wake may still see the active map; this is not an
immediate-delivery or polling-time guarantee.

### Exact-context operator recovery transport

The trusted-local `automation.recoveryTarget` query accepts project, agent and
run IDs. Its owner reads membership and the current run/delivery tuple together,
returning an exact claim/current-send context or a bounded unavailable reason.
It performs no provider discovery, stop, adoption or mutation. History and
workspace origins intentionally omit current send identity and cannot authorize
recovery.

`automation.inspectRun` accepts that full context plus agent ID;
`automation.resolveAmbiguousRun` adds RESOLVE, ABANDON or RETRY. Both verify the
project/agent/run membership before reaching the application's existing recovery
consumer. They preserve the submitted claim and attempt, including the original
initial message and the current message/send attempt. A later action revalidates
independently; stale inspection or target data is never refreshed to make an
action succeed. Inspection returns only safe status and bounded availability,
without prompts, provider source/work evidence or transcripts.

`retryBlocked: RESOURCES_UNAVAILABLE` is separate from common proof, preparation
and child-work blocks. Missing directory, frozen account or session resources
prevent RETRY; otherwise supported RESOLVE/ABANDON still depend on authoritative
stopped-source and current tracked-work proof. PENDING delivery means UNSENT,
while incomplete setup retains its preparation hold. Manual retry keeps the
logical run, reserved workspace/session/account, original message, setup start,
inherited automatic attempt budget and initial outcome; it rotates only the
current send identity and send generation.

The boundary uses existing socket locality, configured CIDRs, browser Origin and
explicit proxy trust rules. Origin-less loopback and other same-user local
processes satisfy locality; this is not authenticated human-versus-agent
isolation. Parent and child workspace MCP advertise only their workspace tools
and the existing sources/propose/getProposal authoring allowlist. They expose no
recovery target, inspection, action or activation tools. No activation or
operational recovery UI is supplied by these endpoints.

A fresh application-construction integration test exercises real production
bridge registration and public workspace deletion without preinstalling capture.
Unseen attached and retained detached PR links survive the cascade as compact
run results; capture or cascade failures roll back the transaction. This
provider-free witness proves construction/deletion wiring, not provider work
resolution or capacity release.
