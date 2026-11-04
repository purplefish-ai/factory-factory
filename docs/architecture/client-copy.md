# Client copy

Use sentence case for headings, buttons, menus, labels and accessible names:
“Quick actions”, “New workspace”, “Create agent”. Keep proper names and acronyms
such as GitHub, Claude, Codex, PR, API and IDE. Use the
[workspace glossary](../workspaces.md#glossary) for product terms. Write
“subagent”, with no hyphen.

Use `…` for pending actions and text truncation: “Loading…”, “Saving…”. Keep
literal syntax such as a sample API key, command, file path or code unchanged.

## Errors and feedback

App-owned errors are clear sentences: “Couldn't load projects.” Say what failed,
then offer the next action when one exists. Put technical detail in a separate
sentence or detail area: “Couldn't save settings. Connection refused”. Headings
and compact status fragments omit the final period: “Couldn't load projects”
above a Retry button, or “Couldn't edit” next to a file name. Query failures
must not appear as empty lists; follow the [loading guide](client-loading.md).

Preserve provider output, transcript text, server error details, logs and
protocol identifiers. Change the app's explanation around them instead of
rewriting their content. `runInBackground` failure messages are visible error
toasts, so they follow this guide too.

Autosaved toggles and selects do not produce success toasts. The changed control
is the confirmation; keep pending/disabled state and report failures. Explicit
Save, validation, export and other user-requested actions may confirm
completion. Keep confirmations short: “PR approved”, “Command executed”. Do not
write “successfully” or use exclamation marks in app-owned toasts.

## Destructive actions

Use the actual operation as the verb:

- **Archive** hides a project or retires a workspace while keeping its records.
  Workspace archiving also commits outstanding changes and removes its worktree;
  state that consequence separately. Do not promise a restore action the app
  does not provide.
- **Remove** detaches an association or removes a named local resource. Explain
  what remains: removing a PR from a workspace leaves the PR on GitHub; removing
  an orphaned worktree deletes its uncommitted files but keeps committed
  branches.
- **Delete** permanently deletes the named records or files. Deleting an agent
  deletes its definition/history, not workspaces it created.

A confirmation title is “{Verb} {object}?” in sentence case. Its body states the
consequence and whether it can be undone, including any retained history or
external objects. The confirm button repeats the verb (“Archive”, “Remove”,
“Delete”, “Stop and close”). Avoid “Are you sure?” and generic “Confirm”.
Closing a live chat preserves its transcript; any discarded queued messages are
lost.

## Dates and times

User-facing dates use the browser's locale and local timezone consistently:
year, abbreviated month and day, with hour and minute for timestamps. Respect
the locale's hour convention. Logs and detailed timestamp tooltips include
seconds; calendar filter labels show the same date without a time. Use the
shared client date/time helpers rather than independent `toLocaleString`
options.

Keep ISO `dateTime` attributes and raw log timestamps for diagnostic precision.
An invalid value displays “Unknown date” and omits an invalid ISO attribute.
