# PR Events in the Main Session

## Intent and agreed behavior

Replace Ratchet's separate fixer conversations with events delivered to the
workspace's main conversation. The main agent retains the context of its task
and decides how to address new GitHub information. This is the sole replacement
for the current Ratchet implementation; there is no legacy/new mode selector.

The user approved monitoring CI, actionable review feedback, and merge
conflicts. Events arriving during a turn queue for the next turn. Do not
interrupt the active turn or add provider-specific steering.

Enabling monitoring gives the selected conversation a short instruction once:
keep the associated PRs moving by addressing relevant CI failures, review
feedback, and conflicts, following the existing task and repository
instructions. Subsequent messages supply changed facts rather than another fixer
prompt. Monitoring does not authorize automatic merging.

## Existing seams and scope

The current Ratchet poller fetches GitHub details, filters review feedback,
deduplicates dispatches, and acquires a transient `ratchet` session. That
session is started or restarted with a dispatch template and has separate
provider selection, permission defaults, completion tracking, and crash retries.

The existing session queue serializes ACP prompts for both Claude and Codex.
Parent/child workspace notifications already demonstrate persist-first delivery,
reserved message IDs, queued dispatch, and recovery using transcript markers.
Reuse these delivery patterns without pretending a GitHub event came from
another workspace.

This work builds on the one-to-many PR association described in
[Multiple Pull Requests per Workspace](2026-10-08-multiple-workspace-prs-design.md).
That design's PR association, discovery, observation safety, and aggregate
status requirements remain applicable. This design replaces its fixer slot,
per-PR fixer dispatch records, and Ratchet scheduling/lifecycle requirements.
Update that design and its implementation plan when the combined work executes;
do not maintain two contradictory automation designs.

## Session targeting and lifecycle

Persist one recipient session ID per workspace. Enabling monitoring from a
conversation selects that conversation, validating that it belongs to the
workspace and is an ordinary top-level session. Ratchet, adversarial-review,
auto-iteration, and provider subagent sessions cannot be implicit recipients.
Tab focus, latest activity, provider defaults, and newly created sessions never
change the binding.

Enabling from a workspace-level control uses the saved binding. If none exists,
bind the sole eligible session; with multiple candidates, require an explicit
choice in the enable flow. With no eligible session, display that monitoring
needs a recipient rather than creating a session. For new issue workspaces whose
monitoring default is enabled, bind the ordinary implementation session created
by their existing startup flow. The monitor itself never creates one.

An idle, healthy recipient can start an event turn without an open browser or
WebSocket viewer. After backend restart, load the same persisted provider
conversation when needed. Resume failure must leave the event pending and
surface a blocked state; automated event delivery must not fall through to a
fresh provider conversation and lose the task context.

An explicit session stop durably pauses automated delivery until the user
explicitly resumes that session. A new GitHub event, backend restart, or delayed
completion callback cannot clear the pause. A failed session also needs explicit
recovery. A pending permission request, question, or plan approval blocks event
turns without changing or answering the request. Events remain pending while
another workspace session is modifying the shared worktree.

Deleting or closing the recipient leaves monitoring awaiting a new explicit
binding; do not select another conversation automatically. Persist its provider
identity and provider-owned transcript reference before deleting the live
session row. Preserve the frozen delivery's original session identity until
every in-flight or uncertain send has been receipt-reconciled, including through
user-requested conversation rollover. Never resend an uncertain frozen group to
a new binding before checking the original provider history. Rebinding
invalidates unstarted queue entries for the old target and revalidates current
pending facts for the new one. It cannot transfer a turn already in progress.

Disabling monitoring invalidates pending automated messages and prevents new
event turns. It does not stop the main session or interrupt a turn already
dispatched. Archive, PR detachment, session stop, disable, and rebinding guards
must be checked again immediately before dispatch, after asynchronous work.

## GitHub observations and event selection

Keep the existing two-minute polling cadence, `jobRunner` lifecycle, GitHub CLI
rate budget, fetch coordination, shutdown cancellation, and review filtering.
Polling remains the event source; GitHub webhooks are not required.

Expand the common PR observation to carry the head commit SHA, CI check/run
identities and outcomes, merge status, and actionable review activity. Cache
refresh and event generation must use the same accepted observation. A
status-only `PR_SNAPSHOT_UPDATED` event is insufficient: its aggregate CI status
cannot identify a rerun or a new review thread.

Coordinate fetches per PR association. A skipped fetch is not evidence that
there are no events, and a cooldown must not hide details fetched by another
caller. Consolidate observation collection or retain the full shared observation
so both consumers can use it. GitHub fetch failures retain the last accepted
facts and retry through the existing polling/backoff behavior.

Observe every associated, non-detached PR. Validate workspace/PR ownership and
observation revision before updating cache or generating events. Stale fetches
cannot recreate a removed association or overwrite a newer observation.

Generate these event kinds:

- CI failure: newly completed failing checks, grouped by observed PR/head.
- CI recovery: checks previously reported failing now succeed.
- Actionable review feedback: new or materially edited feedback accepted by the
  existing review-trigger policy.
- Merge conflict: conflict detected or a previously reported conflict cleared.
- PR terminal state: merged or closed, cancelling its pending fix events and
  providing one final informational update to the recipient.

Pending CI status stays visible in the workspace UI but does not generate a turn
for every progress change. Emit CI recovery only after a reported failure, not a
gratuitous initial-green turn. The initial observation after enable or new
attachment emits any current actionable failures, reviews, or conflicts; it does
not replay historical resolved feedback.

Retain unresolved-thread filtering, review chronology and supersession rules,
deleted-author handling, and the authenticated adversarial-review marker
exception. Ordinary PR conversation comments do not become triggers. Review
feedback can be delivered while CI is pending; it need not wait for terminal CI.

## Identity, persistence, and coalescing

Use workspace-owned persistence with two responsibilities:

- `WorkspacePRMonitoring`: enabled flag, recipient session ID, binding revision,
  monitoring event epoch, explicit delivery pause, and check bookkeeping. This
  replaces the workspace fixer ownership record.
- `WorkspacePREvent`: PR association, event kind, observation/head identity,
  deduplication key, validated payload, timestamps, and delivery state. This
  replaces per-PR fixer dispatch history with event delivery history.

Register the models and their sole resource writers in the service registry. Use
indexed foreign keys and preserve workspace deletion cascades. The nullable
recipient relation must clear on session deletion rather than delete the
monitoring configuration. Validate persisted JSON with specific Zod schemas.

Persist accepted cache changes and new events atomically at the workspace
resource boundary. A unique `(prId, deduplicationKey)` constraint makes repeated
polls and concurrent callers idempotent. Increment the monitoring event epoch on
each disabled-to-enabled transition or enabled recipient change and include it
in every event key. Persist each association's observation epoch so the first
acceptance in the new epoch seeds currently actionable facts, even when the
prior epoch delivered identical content. A newly selected recipient receives
current actionable facts in its new epoch. CI keys include head SHA, check/run
identity, rerun attempt where available, and outcome. If a provider lacks a
native ID, derive a stable identity from its reported check details and run
timestamps; never substitute the poll timestamp. Review keys include feedback
identity and a material-content version. Conflict and terminal events include
the accepted transition identity so a real recurrence is not suppressed.

Events move through pending, dispatching, delivered, superseded, or cancelled
states. Claims are conditional on the binding revision, enabled/pause state, and
still-attached PR identity. Startup reconciles abandoned dispatch claims; an
in-memory enqueue is never a delivery acknowledgement.

Group related pending updates into one bounded message per PR when the session
can dispatch, retaining the member event IDs. Refresh/revalidate before sending:
discard old-head CI failures, resolved/superseded review feedback, cleared
conflicts, and fix updates for terminal or detached PRs. Preserve the final
`PR_MERGED` or `PR_CLOSED` transition notice for a still-attached terminal PR;
terminal state must cancel obsolete fixes without discarding that notice. If
failure and recovery both happened before any delivery, retain the current facts
without starting an obsolete fix turn. Already delivered history remains
unchanged.

Use oldest pending creation time, then PR ID and event ID, for deterministic
ordering across PRs. No global debounce timer is necessary: coalesce pending
events at dispatch. A full in-memory queue leaves durable events pending for a
later delivery attempt rather than dropping them or creating another session.

## Session delivery and message content

Add a reserved PR-event message identity and an explicit background-message
source. Extend the session delivery seam narrowly to support this source while
retaining parent/child notification behavior. Keep GitHub orchestration out of
the session capsule and Prisma access inside workspace resources.

Use the existing dispatch serialization, prompt-completion wakeup, stop
generation fence, and interactive-request gates. Automated messages go behind
already queued human messages and cannot start overlapping turns. User messages
retain their relative order; background events do not continually overtake them.

Background messages inherit current session settings at dispatch. They do not
apply synthetic composer defaults, disable plan mode, reset reasoning effort,
switch models/providers, or escalate permissions. The one-time enable
instruction and review-reply policy are trusted application text; GitHub content
is escaped and explicitly identified as untrusted data.

Each message contains the exact repository and PR URL/number, head SHA and
branch where relevant, observation time, changed check names/outcomes and links,
or the new actionable review feedback with locations and links. Bound the
payload using the existing queue/provider limits; truncation must say what was
omitted and link to the full data. Do not inject full CI logs or all historical
reviews. The agent can fetch details using its existing tools.

For example:

> PR #123 in owner/repo: CI failed for commit abc123. Failed checks: typecheck,
> integration tests. Check details: [links]. Observed at [timestamp].

Include a stable delivery marker in provider-visible text. Do not acknowledge
delivery merely because the application optimistically appended a local user
message. A normally completed prompt confirms delivery; provider-owned history
containing the marker can confirm an interrupted or uncertain send before retry.
If neither confirms receipt, retain the event for bounded retry in the same
conversation and expose repeated transport failures for explicit recovery. Do
not promise exactly-once execution across a crash at the provider boundary.
Explicit resume atomically clears the recoverable pause and renews the exhausted
retry allowance. It preserves the frozen delivery ID, text, original receipt
identity and group members; unrelated newly observed events remain separate.

Successful delivery means the agent received the facts, not that it fixed them.
An unchanged red CI state does not keep reprompting the agent after delivery.
New commits, check reruns, review edits, and actual state transitions can
produce new events. Users can continue the conversation manually when a fix
stalls.

Render a compact PR update row in chat with queued/delivered state and links.
Recover it after reconnect or restart without duplicate cards. The row is
visibly an application update, even if the provider receives it as ordinary
prompt text. Waiting on delivery and waiting on permission/stop must remain
understandable in the workspace status.

## Cutover, compatibility, and removal

Ship one cutover with no coexistence option. Remove `fixerSessionService`,
ratchet provider selection, `ratchet` session acquisition/restart, the dispatch
prompt/template, fixer outcome/retry/stalled fields, and fixer-specific session
exit hooks and bridge calls. Replace the ratchet poll job with the PR watcher;
do not run both. Session activity and pending event delivery replace the old
fixer-based working/stalled projections in snapshots and Kanban status.

Preserve existing enable defaults and workspace toggles. Retain the familiar
Ratchet control if useful, but change all explanatory copy to describe queued PR
updates to the main session. Show its recipient and a blocked state when a
recipient or explicit resume is needed. Retain review-trigger and review-reply
preferences, applying reply-policy changes to later delivery instructions.
Enabling monitoring does not automatically merge a PR or alter its draft state.

Remove the separate ratchet provider and fixer permission controls.
Auto-iteration currently reads `ratchetPermissions`; migrate that value to an
auto-iteration permission setting before removing the old shared setting.
Preserve auto-iteration's behavior and adversarial review's independent
sessions.

For existing enabled workspaces, preserve a previously known ordinary startup
session binding where available. Otherwise bind only when there is one eligible
session; multiple candidates require user selection. Never adopt a legacy fixer
as the main conversation. Seed current actionable facts for delivery once a
recipient is selected; old dispatch hashes cannot serve as event identities.

Retire legacy fixer runtimes during startup cutover, retaining their transcripts
through closed-session history before removing obsolete records. Cleanup failure
blocks that workspace's automatic delivery and surfaces recovery rather than
allowing an old fixer and the main session to modify its worktree together.
Legacy ratchet session rows must never be implicitly restarted by new delivery.
No GitHub event stops or deletes the main conversation when one PR merges.

Update backup export/import for the new configuration and event ledger. Continue
accepting the older singleton-PR and multiple-PR backup formats. Preserve
enable/review/reply settings, PR history, and session transcripts; obsolete
fixer dispatch data is retired rather than interpreted as event
acknowledgements. Clear runtime claims on import. Validate any recipient against
restored sessions and require binding when it cannot be resolved. New-format
round trips retain pending and delivered event identities to avoid historical
redelivery.

## Implementation sequence

1. Build durable PR event persistence and session delivery, including recipient
   binding, settings inheritance, pause/generation fences, markers, and
   recovery. Verify the delivery seam with both provider adapters and
   parent/child notification regressions before connecting live GitHub
   observations.
2. Convert the existing watcher and shared GitHub observations to emit per-PR
   events. Implement event identity, actionable filtering, coalescing, and stale
   cancellation, then replace fixer dispatch and lifecycle bookkeeping. Land the
   user-visible switch together with legacy shutdown/migration. Intermediate
   development commits do not expose a second selectable mode.
3. Complete settings, snapshot/Kanban, transcript UI, backups, and documentation
   changes. Reconcile the multiple-PR plan and finish the migration,
   integration, and UI regressions before releasing the cutover.

## Verification and acceptance

Focused tests must demonstrate:

- A failure received during a long-running main turn is queued, sent after that
  turn, and processed by the same AgentSession/provider conversation. No fixer
  row, ACP restart, cancellation, or concurrent prompt is created.
- Healthy idle delivery works without a viewer. Explicit stop, process failure,
  plan approval, permissions, questions, and another working session block it;
  backend restart and late callbacks cannot undo an explicit stop.
- Model, provider, reasoning effort, plan mode, and permissions are preserved.
  Event-triggered provider resume failure cannot create a fresh conversation.
- Repeated polls are idempotent; a same-head rerun is new; old-head failures are
  superseded; pending failure/recovery pairs do not start obsolete remediation.
- Existing review filters and adversarial-review exceptions remain correct,
  including edited feedback, resolved threads, and superseding approvals.
- Two PRs are observed independently and delivered serially with exact targets.
  Detaching, closing, or merging one cancels its pending fixes without stopping
  the main session or losing the other PR's events.
- Disable, archive, rebind, session deletion, and PR removal during asynchronous
  dispatch preparation prevent stale delivery. Already running main turns remain
  under the ordinary session lifecycle.
- Queue overflow retains durable events. Concurrent claims do not duplicate a
  turn. Crash recovery uses provider markers rather than optimistic local
  transcript writes; transport failures do not resurrect fixer crash retries.
- Legacy migration and older backup import preserve ordinary conversations and
  user preferences, retire old fixers safely, and do not replay old feedback.
  New-format backup round trips retain event delivery state.
- Parent/child notifications, auto-iteration permissions, adversarial review,
  session stop barriers, and aggregate multi-PR archive rules keep working.

Add UI tests and stories for enabled/disabled monitoring, recipient selection,
queued updates, waiting for resume, delivery error, and multiple PRs. Verify
desktop/mobile layout and keyboard behavior using the existing dialog and theme
patterns. Update the pull-request, agent-runtime, background-job, and
workspace-state architecture notes to describe the replacement.

Use Node >=26.8.1 and pnpm 12.4.2. Run `pnpm check:fix`, `pnpm typecheck`,
affected `pnpm test` files, `pnpm check`, and `pnpm check:prisma-schema` for the
schema changes. Inspect the final diff and report unavailable or failing checks.
