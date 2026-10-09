# PR event delivery destinations

The approved event-driven PR system supports two destinations through one
workspace setting. `MAIN` remains the default. `DEDICATED` creates and reuses
one ordinary provider conversation per attached PR. Observation, reduction,
deduplication, queued chat cards, receipt recovery, retry budgets and workspace
busy guards remain shared. The removed legacy fixer engine stays retired.

## Configuration and recipients

`WorkspacePRMonitoring.deliveryMode` persists `MAIN` or `DEDICATED`, defaulting
to `MAIN` for existing databases and backups. Mode changes use the existing
binding revision compare-and-swap, invalidate stale queue tokens, and start a
new observation epoch. The main recipient is retained as a preference while
dedicated mode is selected. Only main mode requires an ordinary recipient.

The workspace PR menu exposes both destinations. Main mode keeps the existing
recipient picker. Dedicated mode describes its automatic per-PR conversations
and uses normal workspace provider, model and permissions defaults. It does not
add separate Ratchet provider or permission settings.

`WorkspacePRDedicatedSession` binds a PR ID to a nullable AgentSession ID. The
session capsule owns this table and atomically acquires its conversation under
the normal workspace session limit. The new workflow is `pr-monitoring`; it is
excluded from ordinary recipient selection. Missing or detached PRs and inactive
workspaces cannot acquire sessions. Concurrent wakeups reuse the same binding.
Deletion clears the binding but never rewrites frozen delivery IDs.

Creation is lazy: enabling dedicated mode alone creates no session. A pending PR
event creates its recipient. Workspace-wide enablement controls remain
main-only; each dedicated fact batch includes concise trusted maintenance
instructions. Bootstrap creates provider identity without dispatching a separate
large initial prompt. Existing dedicated conversations resume their exact saved
provider identity and settings, using the shared delivery path.

## Delivery and transitions

Every per-PR batch chooses its recipient before claiming. Resource claims and
both submission guards validate the configured mode, binding revision and
recipient ownership. Dedicated sessions can receive only their bound PR's
events. Human messages keep priority and workspace-wide working-agent guards
continue to prevent concurrent editing.

Frozen deliveries retain their original session, provider identity, UUID and
text. Switching modes never retargets them. Recovery checks the original
provider-owned receipt; a proven receipt settles the old claim, proven absence
can cancel an obsolete claim, and unavailable history pauses delivery. Future
unclaimed events use the selected mode. Turning monitoring off and switching
modes must fence preparation and creation as well as submission.

Stopping or failing a bound dedicated conversation pauses workspace monitoring,
matching the current main-recipient contract. Explicit user continuation clears
recoverable pauses through the shared resume fence. A closed or deleted
conversation remains recoverable through archived provider history; a new
conversation is permitted only for future delivery after old claims reconcile.

## Persistence and validation

An additive migration preserves existing bindings and mode defaults. Backups
preserve delivery mode and per-PR dedicated session associations. Restore
validates workspace/PR/session ownership after session rows exist. Older backups
default to main mode. Provider receipts and frozen delivery metadata retain
their current meaning.

Regressions cover mode defaults and CAS changes; concurrent acquisition and
limits; per-PR isolation and session reuse; first provider identity creation;
strict subsequent resume; switching with live/frozen deliveries; stop/resume
fences; deletion and receipt recovery; backup roundtrips; and desktop/mobile
menu behavior. Existing main-mode suites continue to pass unchanged in intent.
