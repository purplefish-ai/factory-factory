# Pull Request Automation

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
destination setting, replacing the former fixer engine. Human messages retain
FIFO priority; a background update waits for an idle recipient, no interactive
request, and no working agent in the workspace. An update arriving mid-turn
stays queued for the next turn.

Enablement and delivery destination are workspace-scoped. In MAIN mode, a unique
ordinary conversation can be bound automatically; multiple candidates require an
explicit choice. Auxiliary Ratchet, PR-monitoring, auto-iteration, and
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

An existing dedicated conversation receives its queued chat card even while
another session is working. Creating a new provider conversation waits for an
idle workspace; session idle transitions wake pending PR delivery immediately.

Each `WorkspacePR` association has its own ID, URL, revision, complete
normalized observation, epoch, and transition sequence. `WorkspacePRDiscovery`
owns branch lookup scheduling separately. An observation and its
`WorkspacePREvent` rows are accepted in one transaction, guarded by association
identity and revision. Attaching or merging one PR preserves sibling
associations and events.

`WorkspacePRMonitoring` owns enablement, delivery mode, main recipient
preference, binding revision, epoch, and delivery pause. Turning monitoring off
cancels unclaimed events while facts continue to refresh. Re-enabling or
changing destinations/recipients starts an observation epoch. MAIN queues one
trusted enablement control; DEDICATED batches carry concise maintenance
instructions in the same bounded event message. Collection projections report
MERGED only when every attached PR is merged; an open sibling remains visible.
Workspace snapshots include the plain `prs` collection and its `prSummary`. The
PR menu offers per-association refresh, review, and detachment. Detaching one
association cancels its pending events while leaving sibling monitoring and the
main conversation intact.

### Observations and events

Polling, manual refresh, and dispatch preparation share normalized observation
fetching through `pr-observation.orchestrator.ts`. Coalescing is scoped to
workspace/PR identity and revision/epoch; separate PRs do not share a baseline.
GitHub owns process-wide spawn limits, in-flight read deduplication, and rate
limit backoff. Watcher concurrency remains bounded at three workspaces, with a
90-second timeout and shutdown cancellation.

Observation depends on four method-level ports: normalized fetching, PR/config
reads, atomic observation acceptance, and snapshot notifications. It has no
session or delivery dependencies. Delivery receives a `refreshObservation`
callback from composition wiring and awaits it before claiming events, then
rechecks the recipient binding. Recipient readiness belongs to delivery.

`prFactPayloadSchema` validates GitHub-derived facts; the transition reducer
accepts and emits only those facts. `prMonitoringControlPayloadSchema` validates
backend-owned enable instructions separately, with a separate message builder.
The ledger retains its compatible payload union, but rendering rejects mixed
control/fact batches instead of silently omitting facts. The reducer
deliberately reads pending, in-flight, and delivered fact history for
deduplication and recovery semantics; it does not choose a session, destination,
or prompt.

The reducer emits changed CI failures, recovery after a delivered failure,
actionable review additions or edits, conflict transitions, and merge/close
transitions. Check details, head SHA, and transition sequence distinguish reruns
and recurrences. An unchanged red observation never sends another prompt merely
because the agent left CI red. Unfrozen obsolete facts are superseded; frozen
retry messages keep the original text and UUID. A destination-only switch
preserves queued facts so the new recipient can receive them.

Review policy defaults to `CHANGES_REQUESTED`: changes-requested review bodies
and unresolved inline threads. `ALL_REVIEW_FEEDBACK` also includes commented
review summaries. Ordinary PR conversation comments do not trigger updates. The
app's own [adversarial-review marker](../design/adversarial-review.md) remains
an explicit exception under its authenticated GitHub identity.

Approvals supersede earlier feedback only with reliable same-author ordering.
Submission times and REST review ordinals provide that ordering; opaque IDs do
not. Deleted reviewers retain their feedback under an unknown identity, and
unknown authors' approvals cannot erase each other's feedback. Resolved threads
are excluded. Pagination caps mark reviews incomplete, so omitted feedback is
retained rather than inferred resolved. Unknown CI results never become green.

### Delivery and recovery

The session queue carries a backend-owned `pr_event` source. Browser messages
cannot supply it or reserved message IDs. Preparation refreshes facts and checks
eligibility before freezing a bounded message (16 KiB UTF-8), event IDs,
delivery UUID, recipient, binding revision, and attempt. The final guard runs
again immediately before provider submission. A transactional workspace-wide
claim permits only one PR delivery at a time, including across dedicated
conversations. A competing claim retains its queued card and retries when the
active delivery settles. Review data is escaped, explicitly untrusted, and
includes PR links and omission counts.

Cold delivery requires resuming the exact stored Claude/Codex conversation.
Failed or unsupported resume cannot fall back to a new conversation. Saved ACP
model, mode, reasoning and permissions are restored; PR updates never apply
separate Ratchet provider or permission defaults.

A completed provider prompt acknowledges delivery, meaning the facts were
received, regardless of whether the PR was fixed. After an uncertain exit,
provider-owned user history must contain the exact delivery marker to prove
receipt; optimistic UI rows are insufficient. Missing history pauses delivery as
`RECEIPT_UNAVAILABLE`. Loaded history without the marker allows a bounded retry
in the same conversation. A recipient change first recovers old claims; only
proven absence allows cancelling an old frozen delivery. It never retargets that
frozen message into a new conversation.

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
chat renders PR updates as noneditable cards. Snapshots expose enablement,
delivery mode, recipient, pause reason and pending count. Queued updates, paused
delivery, and idle red CI do not imply live agent work.

### Migration and backups

The cutover retains exact legacy fixer IDs and all session/transcript rows,
retires and archives each legacy fixer, and fences delivery until retention is
confirmed. It drops old fixer dispatch tables and the Ratchet provider override.
Existing enabled workspaces bind their sole ordinary conversation during
migration. Ambiguous workspaces require an explicit recipient selection. The
former permission default migrates to `autoIterationPermissions` for the
independent auto-iteration workflow. Main conversation settings remain intact.

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
