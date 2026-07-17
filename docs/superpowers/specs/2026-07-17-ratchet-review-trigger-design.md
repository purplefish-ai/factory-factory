# Ratchet Review Trigger and Dispatch Lifecycle Design

## Context

Workspace `cmroxwan8001mwjpzl6usndg5` exposed two independent Ratchet problems on PR #1940:

1. A coverage-report comment update counted as new review activity. Once that gate opened,
   non-empty top-level `COMMENTED` review summaries counted as actionable even though every inline
   thread was resolved and one summary explicitly said all issues were addressed.
2. Ratchet waited for the entire ACP turn before recording the dispatch. The 90-second workspace
   check timeout therefore aborted the check before its dispatch snapshot was persisted, even
   though the fixer session continued working for much longer.

The first Ratchet run on that PR was useful: it received six unresolved inline findings. The second
run was redundant: it received only stale or non-actionable top-level summaries.

## Goals

- Preserve dispatches for failed CI, merge conflicts, `CHANGES_REQUESTED` reviews, and unresolved
  inline review threads.
- Make dispatches caused solely by top-level `COMMENTED` review summaries a global opt-in.
- Default existing and new installations to the conservative behavior.
- Exclude ordinary PR conversation comments, such as coverage and deployment notices, from review
  triggering and review snapshot advancement.
- Record a fixer dispatch promptly after prompt execution is initiated rather than after the ACP
  turn finishes.
- Preserve the existing disable race protection, orphan cleanup, and bounded retry behavior.

## Non-goals

- Provider-specific parsing of Cursor, Cubic, or other bot message bodies.
- Per-project or per-workspace review-trigger overrides.
- Changing when Ratchet fixes CI failures or merge conflicts.
- Changing GitHub review-thread resolution state or posting additional replies.

## Global setting

Add a Prisma enum:

```prisma
enum RatchetReviewTriggerMode {
  CHANGES_REQUESTED
  ALL_REVIEW_FEEDBACK
}
```

Add `UserSettings.ratchetReviewTriggerMode`, non-null with a database default of
`CHANGES_REQUESTED`. The migration applies that value to existing settings rows as well as new
rows.

Expose the field through the settings accessor, query/update services, tRPC input schema, backup
and restore format, and generated client types.

Admin > Ratchet Pull Requests receives a select labeled **Review feedback trigger**:

- **Changes requested and unresolved threads** (`CHANGES_REQUESTED`)
- **All review feedback** (`ALL_REVIEW_FEEDBACK`)

The help text explains that the broader mode also allows top-level `COMMENTED` review summaries to
start Ratchet sessions. The conservative selection is the UI fallback while settings are loading or
when reading data created before the migration.

## Review signal classification

PR state fetching must keep four feedback categories distinct:

1. Unresolved inline review-thread comments.
2. Top-level review bodies whose state is `CHANGES_REQUESTED`.
3. Top-level review bodies whose state is `COMMENTED`.
4. Ordinary PR conversation comments.

Resolved inline comments remain excluded from the fixer prompt and from the actionable trigger.
Inline comment timestamps may still participate in the snapshot identity after resolution so that
resolving a thread does not itself create a new snapshot.

Ordinary PR conversation comments never participate in the review trigger, the fixer prompt, or the
review portion of the dispatch snapshot. CI and merge-conflict snapshot components remain
unchanged.

The review snapshot component is mode-aware:

- In `CHANGES_REQUESTED`, it is derived from review activity relevant to `CHANGES_REQUESTED` plus
  all inline review comments, resolved or unresolved.
- In `ALL_REVIEW_FEEDBACK`, it additionally includes top-level `COMMENTED` review submissions.

New review submissions advance the snapshot. Editing an existing top-level review body without a
new review submission does not by itself create another snapshot. This avoids treating bots that
rewrite an existing summary to say "all addressed" as new actionable work.

## Dispatch rules

The following signals trigger Ratchet in both modes:

- Failed CI.
- Merge conflict.
- Current GitHub review decision is `CHANGES_REQUESTED`.
- At least one unresolved inline review thread remains.

`ALL_REVIEW_FEEDBACK` additionally triggers when a non-empty top-level `COMMENTED` review summary
is present in a new dispatch snapshot.

Prompt contents follow the selected mode:

- `CHANGES_REQUESTED` includes unresolved inline comments and current `CHANGES_REQUESTED` review
  bodies.
- `ALL_REVIEW_FEEDBACK` additionally includes top-level `COMMENTED` review summaries.
- Neither mode includes ordinary PR conversation comments.

For PR #1940, the first check would still dispatch with its six inline findings. After those threads
were resolved, the coverage-report update and stale review summaries would not dispatch another
session in the default mode.

## Dispatch lifecycle

Starting a Ratchet fixer and completing its ACP turn are separate lifecycle events. The workspace
poll owns only the former.

The dispatch sequence is:

1. Fetch PR state and make the dispatch decision.
2. Acquire and start or restart the fixer session.
3. Inject the committed user message and initiate the ACP prompt request.
4. Persist the session pointer, snapshot key, `RUNNING` outcome, and retry count with
   `recordRatchetDispatchIfEnabled`.
5. Immediately mark side effects committed so the workspace-check timeout no longer applies.
6. Finish the Ratchet state/snapshot updates and return from the poll.
7. Observe ACP turn completion independently of the poll.

The session bridge/fixer acquisition result should expose a prompt-completion promise or equivalent
internal handle. Initiating the prompt must not await that promise before step 4. Normal completion
continues through the existing active-session reconciliation path.

## Failure and race handling

- **Session startup failure:** return an error and persist no dispatch record.
- **Prompt initiation failure before persistence:** stop the session and persist no dispatch record.
- **Ratchet disabled before persistence:** the conditional write loses; stop the new session and
  report Ratchet disabled.
- **Dispatch-record persistence failure:** stop the unrecorded session and return an error.
- **Workspace timeout before persistence:** abort and clean up the unrecorded session.
- **Prompt rejection after persistence:** conditionally settle that session's dispatch as `DIED`,
  stop it, and let the existing bounded retry policy decide whether to retry the unchanged snapshot.
- **Concurrent session end:** all settlement remains conditional on the active pointer naming the
  same session, so only one completion path wins.
- **Long-running healthy turn:** the dispatch remains `RUNNING`; the workspace check does not time
  out merely because the agent needs more than 90 seconds.

## Testing

### Review behavior

- Default mode dispatches for unresolved inline `COMMENTED` threads.
- Default mode dispatches for `CHANGES_REQUESTED` without inline threads.
- Default mode does not dispatch for a top-level `COMMENTED` summary alone.
- Broad mode dispatches for a top-level `COMMENTED` summary in a new snapshot.
- Coverage, deployment, and other ordinary conversation comment updates do not advance the review
  snapshot or dispatch in either mode.
- Resolved inline threads are absent from prompts and do not trigger.
- Resolving a thread does not create a new dispatch snapshot.
- Prompt contents match the selected mode.

### Dispatch lifecycle

- A fixer turn that exceeds 90 seconds is recorded once and remains active without a workspace-check
  timeout.
- Startup and prompt-initiation failures leave no dispatch record.
- A lost disable race stops the unrecorded session.
- A dispatch-record write failure stops the unrecorded session.
- A post-persistence prompt rejection settles the matching dispatch as `DIED` and observes the retry
  cap.
- A stale completion callback cannot settle a newer active session.

### Settings and compatibility

- Migration and accessor defaults are `CHANGES_REQUESTED` for existing and new rows.
- Settings update validation accepts only the two enum values.
- Backup/restore round-trips the setting and defaults old backups conservatively.
- Admin select renders the current value, saves changes, disables while pending, and reports errors.
- Existing Ratchet settings tests and data-backup fixtures include the new field.

## Documentation

Update the repository feature notes to document the global review-trigger modes, their default, and
the fact that ordinary PR conversation comments do not trigger Ratchet. Document that fixer dispatch
state is committed when prompt execution begins rather than when the agent turn completes.
