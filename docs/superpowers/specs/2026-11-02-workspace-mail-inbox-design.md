# Durable workspace mail inbox

Approved in conversation: keep workspace correspondence in a durable inbox;
prompt agents with a bounded "you have mail" signal, retrieve summaries and
selected bodies through tools, and acknowledge inspected mail explicitly. The
user requested native subagents, never child workspaces, for implementation.

## Behavior

- Preserve sender/recipient workspace boundaries and existing parent/child send
  tools. Add optional subject, kind, task key and task revision. Default legacy
  untyped sends remain actionable MESSAGE mail.
- Mail kinds: MESSAGE, PROGRESS, BLOCKER, QUESTION, COMPLETION, INSTRUCTION.
  PROGRESS is quiet; all other kinds are actionable. Only PROGRESS for the same
  sender, recipient and nonempty task key can supersede older progress. Never
  collapse instructions, blockers, questions or completion messages.
- Use a monotonic per-workspace revision and stable message identities. Keep old
  messages for inspection. Existing delivered notifications migrate as already
  acknowledged; pending legacy notifications become inbox mail, not raw prompts.
- List summaries with bounded previews, cursor pagination and filters. Read only
  selected bodies with a bounded total response budget and offsets for long
  content. Explicit acknowledgement is separate from reading and task
  completion. Scope every operation, including IDs, to the recipient workspace.
- One durable wake latch per workspace. A bounded body-free notice tells the
  agent to use list_mail/read_mail/ack_mail. Arrivals while latched do not
  create extra prompts. An acknowledgement includes the observed revision;
  arrivals after that revision remain eligible for another signal. Partial reads
  and stale acknowledgements must not acknowledge unseen messages.
- Track persisted mail, queued/notified wake, read and acknowledged separately.
  Never call a queued message delivered. Failed/full-queue wake attempts remain
  retryable and recover without requiring backend restart.
- Prefer a supported native steer for the small signal during an active turn;
  retain a bounded queued fallback when unavailable. Never inject mail bodies.
  Use existing permission and session ownership fences. Do not weaken approvals
  or cancel active coding turns to deliver ordinary mail.
- Ambiguous native acceptance is durable and quarantined from automatic replay.
  Persist the native-attempt uncertainty fence before invoking the provider; a
  failed fence write must prevent that native send. Expose its state in inbox
  summaries and provide an explicit, trusted retry action warning that the agent
  may be notified again. Late receipts are fenced from replacement attempts;
  backend restart cannot silently resend uncertainty.
- Startup installs the explicit assignment/context before any mail wake. No
  recovered notification turn may block the initial assignment.
- Provide a workspace inbox UI with unread state, summaries, selected-message
  reading, explicit acknowledgement, loading/error handling and pagination.

## Shared contract

Shared schemas/types live in src/shared/workspace-mail.ts. The existing
workspaceNotificationService remains the workspace capsule facade. It exposes
listMail({workspaceId,cursor?,limit?,unreadOnly?,kinds?,includeSuperseded?}),
readMail({workspaceId,ids,maxChars?,offset?}),
ackMail({workspaceId,ids,throughRevision}), and claimWake/settleWake/releaseWake
with workspaceId and revision. Lists return items, nextCursor, revision and
wakeAmbiguous. The includeSuperseded option defaults to false; enabling it
includes replaced progress updates. Inbox previews and bodies require the same
trusted-local boundary as acknowledgement and explicit wake retry. Summary items
expose id, revision, subject, preview, kind, taskKey/taskRevision, source
workspace names/IDs, createdAt, readAt, acknowledgedAt and supersededAt. Read
results expose selected text, offset and nextOffset; total returned body text
defaults to 8,192 characters and cannot exceed 16,384. Summary pages default 20
and cap 50; previews cap 160 characters. ID batches cap 20.

The runtime owner and persistence owner may refine the wake-port return shape in
direct coordination; record the final contract in the implementation ledger. No
native/workspace concurrency-budget product is included in this feature.

## Verification

Pin concurrent sends, 1,000 quiet updates, bounded bodies and previews,
pagination, cross-workspace IDs, stale acknowledgement with a concurrent
arrival, one wake under bursts, failed/full queue recovery, native-steer
fallback, restart recovery and assignment-first startup. Use disposable database
paths. Run shared project checks, full tests once at integration, applicable
integration tests, Storybook and one final independent review plus Cubic review.
Never mutate the live inbox.
