# Pull Request Automation

## Review requests

The Reviews list and review badge exclude repositories archived on GitHub at the
search source. They also exclude PRs attached only to ARCHIVING or ARCHIVED
workspaces. A PR attached to a live workspace remains visible, even when an
archived workspace also references it. Requests without a local workspace remain
visible; detached associations do not affect visibility. Filtering reads current
workspace state after each GitHub list fetch, so restoring a workspace makes its
requests eligible again on the next refresh.

## PR link previews

GitHub pull request links in chat Markdown show a preview on hover or keyboard
focus. The card includes the PR state, repository, title, author, creation age,
and changed-line and file counts. Links retain their original destinations,
including comment anchors and file paths. Escape dismisses the preview.
Repository display names retain the link's casing; query keys normalize casing
so equivalent links share cached metadata. PRs created within five seconds show
their age as `now`.

Preview metadata loads only when the card opens, through the local authenticated
GitHub CLI and its shared read budget. The client shares cached results for one
minute across matching PR links. Previews request no reviews, comments, checks,
or diffs. Failed reads show an unavailable state while keeping the link usable.
Other hosts, issue links, and workspace file links retain their existing
behavior.

## PR detail diffs

The PR detail panel uses `parseFileDiff` in `src/lib/diff/parse.ts` to display
repository-relative destination filenames. It distinguishes Git's `a/` and `b/`
prefixes from characters inside paths, decodes Git's quoted paths, and uses
destination and rename metadata to disambiguate filenames containing spaces.
Metadata only updates filenames before a hunk; header-like additions and
deletions inside hunks remain diff content.

## PR event delivery destinations

PR monitoring replaces the former Ratchet fixer workflow. The two-minute
`pr-event-poll` job observes every attached PR and queues actionable updates in
either a bound ordinary conversation (MAIN, the default) or one reusable
dedicated conversation per PR (DEDICATED). This is one event pipeline with a
destination setting, replacing the former fixer engine. Queued non-command human
messages are provided together in FIFO order on the next agent turn. Slash
commands run in standalone turns. A ready background update joins those messages
in the same provider prompt. Background updates wait for an idle recipient, no
interactive request, and no working agent in the workspace. An update arriving
mid-turn stays queued for the next turn.

Enablement and delivery destination are workspace-scoped. In MAIN mode, a unique
ordinary conversation can be bound automatically; multiple candidates require an
explicit choice. Auxiliary Ratchet, PR-monitoring, retired auto-iteration, and
adversarial-review sessions are ineligible as main recipients. Issue starts bind
their created conversation after its initial human message is queued. The
workspace menu allows changing the destination or main recipient. DEDICATED mode
creates a normal workspace conversation lazily when that PR has pending events,
using the workspace's provider selection, normal user model defaults, and the
normal session limit. `WorkspacePRDedicatedSession`, owned by the session
service, binds one `pr-monitoring` conversation to each PR. Later events reuse
its saved provider identity and settings. Switching back to MAIN retains the
selected main conversation. Binding changes use a revision compare-and-swap and
invalidate queued requests for the old revision.

An existing dedicated conversation receives its queued status row even while
another session is working. Creating a new provider conversation waits for an
idle workspace; session idle transitions wake pending PR delivery immediately.

Every normalized observation that commits new actionable events also wakes
delivery through the event collector, including manual and idle refreshes. The
wake runs asynchronously after the transaction commits and does not fetch GitHub
itself. Unchanged or rejected observations do not request this wake. Existing
dispatch guards still queue updates until the workspace is idle; a failed wake
leaves the durable events for the next poll or idle transition. Monitoring
shutdown invalidates and drains in-flight observation wakes before finishing.

Each `WorkspacePR` association has its own ID, URL, revision, complete
normalized observation, epoch, and transition sequence. `WorkspacePRDiscovery`
owns branch lookup scheduling separately. An observation and its
`WorkspacePREvent` rows are accepted in one transaction, guarded by association
identity and revision. Attaching or merging one PR preserves sibling
associations and events.

Successful ACP prompt turns reset the workspace's PR discovery backoff, as do
runtime exits. ACP processes remain alive between turns, so waiting for process
exit alone can leave a newly opened PR undiscovered after its checks fail. The
reset only makes discovery eligible for the next batched scheduler pass; it does
not perform a GitHub lookup or delay turn completion. Failed, stopping, and
superseded turns do not reset discovery.

`WorkspacePRMonitoring` owns enablement, delivery mode, main recipient
preference, binding revision, epoch, and delivery pause. Turning monitoring off
cancels unclaimed events while facts continue to refresh. Re-enabling or
changing destinations/recipients starts an observation epoch. Enabling
monitoring or binding a recipient does not queue a chat message. Both MAIN and
DEDICATED batches carry concise maintenance instructions with actionable events
in the same bounded message. MAIN batches collect pending facts across attached
PRs for the selected conversation; DEDICATED batches contain only their bound
PR's facts. Legacy workspace-level enablement controls are not delivered or
included in pending counts; they remain available for receipt recovery.
Collection projections report MERGED only when every attached PR is merged; an
open sibling remains visible.

Accepted per-PR `NONE` → `OPEN` observations notify the parent workspace once
for each newly opened association, including attachment and discovery refreshes.
Rejected or unchanged observations do not repeat the notification.

Workspace snapshots include the plain `prs` collection and its `prSummary`. PR
arrays are compared by identity and content, so database row order does not
trigger drift warnings, version bumps, or snapshot broadcasts. Workspace and
ratchet snapshot reads order PRs by ID to keep scalar PR selection consistent.

The PR menu offers per-association refresh, review, and detachment. Detaching
one association cancels its pending events while leaving sibling monitoring and
the main conversation intact. Discovery preserves detached associations as
tombstones; only an explicit attachment clears them.

The ratchet projection and reconciliation select one association for the PR URL,
number, and sync timestamp, preferring a nonterminal PR. State, CI status, and
merge conflicts come from the aggregate summary.

The event collector uses one per-lifetime projection worker for PR collection
and monitoring invalidations. Its narrow database read publishes the complete PR
and monitoring field set together; it does not fetch the broad workspace record.
Invalidations during a read supersede that read and retain their reasons until a
current projection is accepted. For association-aware events, only accepted PR
invalidations run PR-switch refresh and Linear-completion effects.
Monitoring-only refreshes publish facts without invoking those effects. The
worker owns retries and archive/stop fences, and has no GitHub, delivery,
session, or Linear runtime dependency.

Legacy events without an association ID retain immediate scalar cache updates
and PR-switch handling. Their Linear-completion gate retains its narrow read and
missing-row fallback; association-aware completion uses the accepted projection
without another database read.

Manual workspace PR refreshes serialize per workspace so concurrent requests
report a committed lifecycle transition only once. Sibling refresh failures log
their reason while preserving transitions already written by successful reads.

### Observations and events

Polling, manual refresh, and dispatch preparation share normalized observation
fetching through `pr-observation.orchestrator.ts`. Coalescing is scoped to
workspace/PR identity and revision/epoch; separate PRs do not share a baseline.
GitHub owns process-wide spawn limits, in-flight read deduplication, and rate
limit backoff. A connectivity failure pauses new GitHub reads for 30 seconds
across PRs, including reads already queued for a process slot. Reads resume
automatically after the cooldown; failures preserve saved PR facts and remain
eligible for the next polling pass. Opening the shared cooldown logs one
warning, including for lookups whose callers suppress failures. Snapshot refresh
and monitoring report these retryable failures as warnings. Writes are neither
paused by the network read cooldown nor automatically retried. Version and
authentication health checks bypass the network read cooldown; their failures do
not start that cooldown. The GitHub process boundary classifies diagnostic
output without command arguments and marks connectivity failures, including
local read timeouts, with a typed error; storage and observation-persistence
errors keep their error severity. `listIssues`, `getReviewComments`,
`getResolvedReviewCommentIds`, `getPRFullDetails`, and `getPRDiff` warn and
preserve typed connectivity errors for callers. Watcher concurrency remains
bounded at three workspaces, with a 90-second timeout and shutdown cancellation.

PR attachment and discovery refreshes require that same normalized observer. The
snapshot service owns association lifecycle operations and reads the committed
fields after observation; it has no alternate GitHub fetch or scalar snapshot
writer. Its workspace bridge supplies only collection/context reads, attachment,
discovery attachment, and detachment. Atomic normalized acceptance owns
revision/epoch rejection and ledger updates, and only accepted observations
publish PR transitions for projections and parent notifications.

Observation receives five explicit function ports: PR lookup, monitoring config
lookup, normalized fetching, atomic acceptance, and typed publication of an
accepted observation. The producer imports no runtime application dependencies
and receives no service objects or event emitters. Composition supplies a stable
opaque `cacheScope` shared by polling, manual refresh, and delivery wrappers for
one application graph; distinct graphs have independent in-flight and recent
observation caches. Delivery receives a `refreshObservation` callback from
composition wiring and awaits it before claiming events, then rechecks the
recipient binding. Recipient readiness belongs to delivery.

`prFactPayloadSchema` validates GitHub-derived facts; the transition reducer
accepts and emits only those facts. `prMonitoringControlPayloadSchema` validates
legacy backend-owned enable instructions for backup and receipt compatibility.
The ledger retains its compatible payload union, but rendering rejects mixed
control/fact batches instead of silently omitting facts. The reducer
deliberately reads pending, in-flight, and delivered fact history for
deduplication and recovery semantics; it does not choose a session, destination,
or prompt.

Unclaimed PR event messages use the current trusted reply preference at
delivery. Legacy controls retain their captured `replyToPrComments` in
compatible payloads but no longer start turns. After a delivery is claimed,
retries reuse its frozen text and identity.

Trigger decisions live in the pure `src/shared/pr-trigger-policy.ts` module. Its
draft and ledger-summary types live in `pr-trigger-policy.types.ts`, which
imports only shared schemas. Dependency checks reject runtime dependencies and
imports back through `pr-monitoring.ts`, including type-only imports. The
monitoring facade retains delivery eligibility, pause rules, markers, and the
draft compatibility export used by ledger persistence. The workspace PR accessor
still reduces observations inside the existing revision/epoch transaction; the
policy does not fetch GitHub data, select recipients, or dispatch messages. New
event kinds require an explicit shared schema change.

The reducer emits changed CI failures, recovery after a delivered failure,
actionable review additions or edits, conflict transitions, and merge/close
transitions. Check details, head SHA, and transition sequence distinguish reruns
and recurrences. An unchanged red observation never sends another prompt merely
because the agent left CI red. Unfrozen obsolete facts are superseded; frozen
retry messages keep the original text and UUID. A destination-only switch
preserves queued facts so the new recipient can receive them.

Review policy defaults to `CHANGES_REQUESTED`: changes-requested review bodies
and unresolved inline threads. `ALL_REVIEW_FEEDBACK` also includes commented
review summaries. Ordinary PR conversation comments do not trigger updates. Core
PR, head and check facts are fetched separately from optional review enrichment.
Failed identity, review settings, review or comment lookups mark reviews
incomplete without blocking CI, conflict or terminal-state observations. They
claim no review resolutions, and the existing incomplete-review acceptance
retains pending feedback. Identity must be known before accepting review facts;
failed lookups retry on the next poll without disabling self-review filtering.
The app's own [adversarial-review marker](../design/adversarial-review.md)
remains an explicit exception under its authenticated GitHub identity.

Approvals supersede earlier feedback only with reliable same-author ordering.
Submission times and REST review ordinals provide that ordering; opaque IDs do
not. Deleted reviewers retain their feedback under an unknown identity, and
unknown authors' approvals cannot erase each other's feedback. Resolved threads
are excluded. Pagination caps mark reviews incomplete, so omitted feedback is
retained rather than inferred resolved. Unknown CI results never become green.

### Delivery and recovery

The session queue carries a backend-owned `pr_event` source. Browser messages
cannot supply it or reserved message IDs. MAIN preparation refreshes distinct
PRs with pending candidate facts, with at most three refreshes in flight. Failed
refreshes leave that PR's facts pending while healthy siblings remain eligible;
unrelated attached PRs do not delay delivery. Dedicated preparation refreshes
its bound PR. Frozen retries reuse their exact event set and text without
another GitHub refresh. Preparation checks eligibility before freezing a bounded
message (16 KiB UTF-8), event IDs, delivery UUID, recipient, binding revision,
and attempt. When complete PR identity sections exceed that limit, the batch
claims only the sections represented in its text and leaves the remainder
pending for later turns. The final guard runs again for every event and PR
target immediately before provider submission. Frozen retries preserve their
exact text and complete event set, so later facts wait for a subsequent batch. A
transactional workspace-wide claim permits only one PR delivery at a time,
including across dedicated conversations. A competing claim retains its queued
status row and retries when the active delivery settles. Review data is escaped,
explicitly untrusted, and includes PR links and omission counts.

Cold delivery requires resuming the exact stored Claude/Codex conversation.
Failed or unsupported resume cannot fall back to a new conversation. Saved ACP
model, mode, reasoning and permissions are restored; PR updates never apply
separate Ratchet provider or permission defaults.

Delivery checks that the recipient's worktree is available before claiming an
update. A missing or non-directory worktree pauses delivery as `SESSION_FAILED`,
preserving pending events. Restore a valid worktree directory at the configured
path, then use **Resume PR updates** to retry. The ACP startup preflight also
catches a directory removed after that check. Other filesystem lookup errors
temporarily block delivery without persisting a pause, so a later attempt can
retry.

A completed provider prompt acknowledges delivery, meaning the facts were
received, regardless of whether the PR was fixed. After an uncertain exit,
provider-owned user history must contain the exact delivery marker to prove
receipt; optimistic UI rows are insufficient. Missing history pauses delivery as
`RECEIPT_UNAVAILABLE`. Loaded history without the marker allows a bounded retry
in the same conversation. When that session has a recorded provider identity
rollover, proven absence permits recovery to re-stamp its frozen claim to the
current identity. The recovery transaction fences the identity observed before
receipt lookup and verifies the rollover lineage; unreadable history still
pauses delivery. Frozen message text and delivery IDs remain unchanged. A
recipient change first recovers old claims; only proven absence allows
cancelling an old frozen delivery. It never retargets that frozen message into a
new conversation. If a PR in a frozen MAIN batch is detached, proven absence
allows cancelling that batch and queuing fresh facts for its still-attached PRs.
The original delivery identity and text remain preserved for receipt history.

Closing a conversation retains its provider session ID in archived transcript
metadata. Receipt recovery reads that identity and checks provider-owned
history, including after another conversation is selected. If history is
unavailable, restore the provider history files and archived identity, then
explicitly resume the selected conversation. Local transcript messages cannot
prove receipt.

Transport attempts stop after three failures. User stop and runtime failure
persist a pause and invalidate queued requests; explicit user continuation
clears recoverable pauses and renews the bounded retry allowance while
preserving the original frozen delivery ID and text. The PR menu also offers
explicit **Resume PR updates** for recoverable pauses, including when no
dedicated conversation exists yet. Changing destinations alone preserves a
pause; resuming uses the binding revision and retains frozen recipients. The
chat renders PR updates as compact, noneditable rows with queued, delivered,
failed, or cancelled delivery states. Queued updates appear below current agent
activity as one shared status line, regardless of how many updates are queued;
delivered update contents can be expanded in the transcript. Failed and
cancelled queue outcomes remain in session snapshots and replay; background
prompt text never enters composer recovery. Snapshots expose enablement,
delivery mode, recipient, pause reason and pending count. Queued updates, paused
delivery, and idle red CI do not imply live agent work.

### Migration and backups

The cutover retains exact legacy fixer IDs and all session/transcript rows,
retires and archives each legacy fixer, and fences delivery until retention is
confirmed. It drops old fixer dispatch tables and the Ratchet provider override.
Existing enabled workspaces bind their sole ordinary conversation during
migration. Ambiguous workspaces require an explicit recipient selection. Main
conversation settings remain intact. The later auto-iteration removal drops its
obsolete permission setting without changing PR recipient access.

Version-6 backups preserve every PR association, normalized observation,
monitoring binding/pause, and event including frozen delivery metadata. Versions
4 and 5 remain accepted. Published version-5 fixer identities normalize into
retained legacy IDs and pause delivery until cutover completes; operational
fixer ownership is not restored. Restored process IDs are never trusted as live
runtimes; provider identity is retained for receipt recovery. Invalid restored
recipients are unbound and require selection.

In-flight backup deliveries must include their frozen delivery ID, text,
recipient, binding revision, provider, and provider conversation identity.

The delivery-mode migration is additive: existing monitoring defaults to MAIN.
Version 6 backups retain the destination and dedicated PR/session bindings;
older backups default to MAIN. Binding restoration validates the workspace, PR
and `pr-monitoring` workflow after the sessions have been restored.
