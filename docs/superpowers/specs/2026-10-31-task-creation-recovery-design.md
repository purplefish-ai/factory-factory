# Task creation drafts and recovery

Status: behavior approved in conversation; implementation not started.

## Intent

Users leave the task composer briefly to check something. Their work must
survive navigation, refresh, and creation failures. Keep the current successful
creation flow, including existing mobile column selection, without automatic
navigation into the workspace.

## Agreed behavior

- Keep one creation draft per project: instructions, attachments, and selected
  launch options. Restore it when the composer reopens after navigation or
  refresh.
- Closing the composer preserves its draft. Provide an explicit Discard draft
  action; Escape closes rather than discards.
- Submission errors preserve the editable draft and appear inline. Retrying uses
  the retained inputs. A toast alone is insufficient.
- After successful creation, the workspace durably owns the original
  instructions and attachments; clear the submitted draft. Do not clear a newer
  draft written while that submission was pending.
- If setup fails, the workspace remains discoverable on the board with an error
  icon and a short Setup failed explanation. Recovery belongs in the workspace:
  error details and Retry setup, operating on the same workspace.
- Retry preserves original instructions and attachments without duplicate
  initial task delivery. Do not recreate a workspace to retry its setup.

## Approaches

1. Preserve only the composer. Smaller, but does not address failures after the
   create response closes it.
2. Preserve drafts and cover the full creation flow. Selected because failures
   can happen before persistence or during background setup. Workspace-level
   recovery and a board indicator keep the usual creation flow unchanged.

Multiple named drafts and automatic navigation into a new workspace were
excluded. Cross-device draft synchronization and automatic setup retries are out
of scope.

## Existing behavior and investigation

The inline form uses component-local state and reports request errors with a
toast. Interactive creation persists a workspace before background setup. The
shared status projection already maps SETUP_FAILED to Waiting; existing
workspace views provide retry controls. Initialization failure cleanup marks
FAILED rather than deliberately deleting the workspace. The reported
disappearance still needs a reproducible transition test through the shared
list/snapshot/board path; it is not yet attributed to a particular defect.

## Implementation decisions proposed by the agent

Use browser-local IndexedDB for the draft, including attachment contents, to
avoid putting large attachment payloads into synchronous Web Storage. Scope by
project and version the stored record. Validate restored data with Zod. Keep
in-memory editing usable if storage fails, and visibly explain that persistence
or attachment restoration could not complete. Do not silently drop attachments.

Keep immediate same-window read-your-writes and serialize saves and clears per
project. Bound IndexedDB initialization so blocked storage cannot disable the
composer indefinitely. Test storage in installed Chromium without new
dependencies. Track pending submissions across composer remounts within the same
window. Capture submitted project and revision: late success must neither clear
nor close a newer or different-project draft. Unmounted composers must not
trigger closing or navigation callbacks.

Reuse the session-selection feature's supported launch validation and public
API, extending it to serialize and restore explicit draft selections. Settings
arriving asynchronously must not overwrite restored choices. Preserve the
periodic-agent mode and schedule because the same composer already supports
them; do not expand this change to other creation surfaces.

Reuse the existing canonical status projection and workspace retry path. Add
regressions before changing backend behavior. Read the applicable service guide
before any backend edits. Routine implementation details remain with the
builder.

Reuse the FAILED status badge's existing icon, label, and tooltip. A workspace
without sessions currently hides chat-level recovery behind its empty state;
make setup failure details and retry reachable independently of sessions. Mobile
creation selects Working while failed setup belongs to Waiting; test that
transition without changing successful creation behavior.

## Verification

Cover navigation, refresh, project isolation, draft discard, request failure,
attachment restoration, slow settings hydration, and submit/navigation races.
Exercise a workspace progressing from creation to failed setup and retry through
the shared cache and board. Verify the retained initial task is dispatched once.
Update stories for restored/error states and follow CONTRIBUTING verification.
