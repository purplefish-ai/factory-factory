# Settings

Open Settings from the app navigation. Each section has its own URL, so you can
bookmark it and use the browser's Back button:

- **General** (`/admin`): notifications, preferred IDE, and chat defaults.
- **Workspace** (`/admin/workspace`): child workspaces, ticket dispatch prompts,
  and PR review defaults.
- **Integrations** (`/admin/integrations`): Codex accounts, CLI authentication,
  and Slack.
- **Appearance** (`/admin/appearance`): color scheme, text size, and fonts.
- **Voice** (`/admin/voice`): voice mode and Deepgram credentials.
- **System** (`/admin/system`): API usage, processes, app information, backups,
  and worktree cleanup. Diagnostics poll only while this section is open;
  loading or failed diagnostics never block other settings.
- **Server logs** (`/admin/logs`): searchable logs; `/logs` remains available.
- **Project settings** (`/admin/project`): links to each project's settings at
  `/projects/:slug/settings`, including factory configuration and issue
  tracking. Opening a project's settings does not change the selected project
  elsewhere. Individual project pages keep the settings section navigation, with
  **Project settings** selected. Use the **Projects** breadcrumb to return to
  the project list.

Toggles and preset selects save immediately. Text and secrets use explicit Save
or Connect actions; custom IDE commands and custom font families also submit
with Enter. Failed saves preserve text for retry. Sliders save when you finish
the interaction. Color pickers save when focus leaves the picker, so click or
tab to another control after choosing a color. Linear credentials and their
validated team are submitted together with Save.

Scheduled agents are managed from **Agents** in the sidebar or the Agents link
in Settings. The management page replaces the former Periodic Tasks settings
editor. See [scheduled agents](architecture/integrations.md#scheduled-agents)
for schedule and run behavior.

## Appearance

Color scheme, color overrides, font size, and fonts are saved with the other
user settings and apply on every device that opens this server. Mode is saved in
the browser and does not sync across devices. Presets save immediately; custom
font-family text requires **Save** or Enter. Color pickers save when focus
leaves the picker; sliders save when you finish the interaction.

- **Color scheme** picks a palette. Factory is the default; GitHub, One,
  Solarized, and High contrast are inspired by the corresponding editor themes.
  Every scheme has a light and a dark variant, chosen by **Mode** (or the
  sun/moon toggle in the sidebar). High contrast uses pure black and white with
  solid borders.
- **Background color** and **Text color** override the scheme's page background
  and primary text in both light and dark mode. Cards and secondary text are
  blended from the overrides, but contrast is not checked. Use **Reset** next to
  a color to return to the scheme's own value.
- **Font size** scales the root font size from 75% to 175%. All text and spacing
  defined in `rem` follows it, including the terminal, independently of browser
  zoom.
- **Interface font** and **Monospace font** offer a few bundled stacks,
  including Atkinson Hyperlegible, plus **Custom** for any font installed on the
  device. A custom value is a CSS `font-family` list and may contain only
  letters, numbers, spaces, quotes, commas, periods, underscores, and hyphens.

**Reset appearance** returns every saved appearance preference to its default;
it does not change Mode. The last applied appearance is cached in the browser so
a reload does not flash the defaults before the saved settings load.

In the installed desktop PWA, the browser-owned corner backgrounds follow the
page color and dim with search and other dialog backdrops. Closing a dialog
restores the current page color; the browser still draws the window buttons. The
saved Mode is also applied before React starts, so a refresh initializes the
corner backgrounds with the selected light or dark mode.

Tooltips, menus, popovers, dialogs, and sheets treat the bottom of the native
title bar as the top edge of their usable area. Tooltips for title-bar controls
open into the page below it, including the side-panel toggles.

## Notifications

**Desktop notifications** start off on each browser or desktop-app profile.
Turning it on requests browser permission directly from the switch. Completion
events never request permission in the background. Permission and the opt-in are
local to this browser; they do not change another device's notifications.
Blocked browsers show instructions to allow notifications in browser settings.
Unsupported browsers keep the switch disabled. Turning it off stops desktop
alerts without changing completion sounds.

Selecting a completion notification closes it, focuses the app, and opens the
workspace using its current project. The desktop app also restores a minimized
window. Deleted workspaces show an error instead of navigating to a stale link.
Notification tags use workspace IDs, so workspaces sharing a name remain
separate. With Web Locks and browser storage available, one tab claims each
completion before playing its sound or showing its alert. The browser remembers
the latest 1,000 completion identities; an older completion can alert again
after it is evicted. Each tab still receives its attention indicator. If Web
Locks or storage is unavailable, alerts fall back to per-tab delivery and recent
in-memory deduplication, so separate tabs may each alert.

**Play completion sound** saves to the server and applies across devices. Voice
mode suppresses the completion chime while microphone capture is active,
including listening and thinking phases. Desktop alerts and sounds can be
enabled independently. App badges are deferred because completion attention
currently has no reliable unread/acknowledgement lifecycle; a badge count could
stay stale after a workspace is viewed.

## Backup imports

New exports use schema version 8 with the frozen `base-json-slack-connections-1`
partial coverage manifest. This cumulative profile includes base logical
metadata, periodic configuration and workspace links, retained periodic
execution history, automation definition bodies and Slack connection metadata.
Repository/worktree files, provider history bytes, archives, mail, secrets,
native account homes and live runtime authority remain excluded. Paths and
provider-session IDs may remain metadata. Workspace.creationMetadata,
WorkspacePR.observation on actual included PR rows,
AgentSession.providerMetadata and PeriodicTaskExecution.launchSnapshot preserve
SQL NULL versus top-level JSON null. All five version-1 recovery sections are
required, including when empty. Frozen older profiles retain their historical
capabilities, null semantics and warnings. Import requires all 37 canonical
model classifications and the profile's exact global exclusions; unknown
capabilities or sections reject before opening the writer. Versions 4–7 retain
their legacy behavior and report no versioned coverage declaration.

The current-session result and its exact JSON download include partial-coverage
warnings and, for v8, the file's manifest. Four numeric primary counters and the
user-settings booleans remain measured import outcomes. Embedded row totals and
account remapping totals are explicitly unreported, not zero; inert changes may
overlap those primary counts.

Slack connection metadata restores disconnected, without tokens; reconnect
manually in Slack settings. The report counts source enabled rows across the
entire source section, imports restored disabled and skips for any existing
connection ID or Slack workspace identity. Existing local connections stay
unchanged. GitHub connections, connection bindings and event configuration are
excluded. Definition bodies and execution preferences still restore disabled;
inspect bodies and author complete event configuration where editing is
available. Archived projects and definitions at their revision limit retain
ordinary editing restrictions.

Blank Slack connection IDs and workspace identifiers reject on import. A stored
blank connection ID or workspace identifier also makes the current export fail
visibly, leaving that row untouched. Meaningful opaque identity text, including
padding, is preserved without trimming. This metadata recovery and manual Slack
settings management do not restore event bindings or bypass separate agent
authoring limits.

Before opening the restore transaction, versions 4–8 validate the complete
source graph after legacy normalization. Duplicate project identities or slugs,
workspace/session/terminal/PR/event IDs, event deduplication keys, contradictory
declared ownership and invalid parent links reject the whole file. A declared
parent must be a different root in the same file and project; children may
appear before their parents. Missing projects remain scoped skips.

Receipt members must belong to one workspace. Contradictory frozen metadata
within that workspace remains quarantined historical evidence: every raw member
survives export, inert import and re-export, with no implied delivery success.
These formats cannot prove membership omitted from the original file.

Imports of backup versions 4–8 restore runtime metadata with processes stopped.
Run-script commands, cleanup commands, terminal labels and provider history
identities remain available, but process IDs, run-script ports and start times
are cleared. Previously completed or failed process statuses remain historical;
running and transitional process statuses become idle.

Workspaces restored from NEW, PROVISIONING or ARCHIVING become FAILED and show
their original status with manual recovery guidance. Import and startup do not
resume initialization or archive cleanup. Review the workspace before retrying.

PR monitoring restores disabled for MAIN and DEDICATED delivery modes.
Unfinished imported receipt groups remain blocked even after monitoring is
enabled again, its recipient changes or the server restarts. Their raw frozen
text, identities, states and timestamps remain historical evidence; unclaimed
pending facts are cancelled without claiming delivery. Settled receipt evidence
is retained. Versions 4–7 flatten receipt members and do not encode their
original frozen ordering; import retains the existing creation-time/ID
membership interpretation and never uses unfinished imported receipts to
authorize another send.

Successful import results stay available in the current app session until you
select **Dismiss**, including after navigation or a data refresh. Each completed
import keeps its own result; dismissing one reveals the next. **Download JSON**
saves the exact returned result without dismissing it. Results are held in
memory and do not survive reloading or closing the app.

The result lists actual imported and skipped counts for projects, workspaces,
agent sessions and terminal sessions, plus runtime changes for newly created
rows. User settings are reported as imported, skipped or none. Already inert
values and skipped existing runtime rows do not count as changes. Runtime
changes may overlap those record counts. Embedded row totals and account
remapping totals are not reported; this does not mean zero.

Destination collisions skip the affected workspace and its child workspaces as a
group, including their sessions, PR configuration, events and metadata. Existing
workspace history and runtime owners stay unchanged. A project already present
admits new workspaces only when its ID, slug, repository/worktree paths and
GitHub owner/repository match exactly. Existing PR IDs, imported or historical
session references, event IDs and receipt identities cannot lend ownership to an
imported group. Even an inert historical session reference skips its group when
that ID exists locally; an absent historical reference remains evidence.
Unrelated eligible groups still restore, and receipts retain all their members.

## CLI notices

Claude and Codex runtimes are bundled with Factory Factory and updated with app
releases. No separate global installation or provider update action is needed.
Use `ff claude auth login` and `ff codex login` to authenticate the same
runtimes used by sessions. The setup terminal also offers **Sign in to Claude**
and **Sign in to Codex** buttons that launch the app's managed runtimes
directly, including in desktop installs without a global `ff` or Node
installation. Missing bundled runtimes require updating or reinstalling Factory
Factory.

Missing tools and GitHub sign-in problems appear as amber notices with setup
instructions. **Recheck** refreshes their status. Dismissing the strip keeps it
hidden across reloads until the issue details change; resolved notices
disappear.

## Custom IDE commands

Select **Custom** under **Preferred IDE** to reveal the command field. For a new
custom IDE, the saved preference remains unchanged until a nonempty command is
saved successfully. Enter a command such as `code-insiders {workspace}`, then
choose **Save** or press Enter to save it. The command must include
`{workspace}` and pass the server's command validation. A rejected save leaves
the field available to edit.

**Test** runs the command currently in the field. Choosing Cursor or VS Code
preserves the saved custom command for later use.

## Chat defaults

An app-wide warning appears when a saved default Claude or Codex model is
missing from its live catalog. **Review chat defaults** opens Settings so you
can choose a current model. The warning clears after the default changes or the
model returns to the catalog. While a warning is visible, the catalog is checked
once a minute. Returning to the app also refreshes a stale catalog. Discovery
failures and fallback lists do not trigger a warning for that provider;
supported Claude aliases and Codex's native `default` remain valid. The warning
does not change your saved selection.

Model selections save immediately. If a save fails, the affected model selector
returns to the saved value and an error toast appears. A late failure from an
older selection does not replace a newer selection, even when the same model is
selected again. Selectors stay disabled until the save and its settings refresh
finish. Delayed refreshes cannot replace a pending choice; later server changes
synchronize normally after saves settle.

## Worktree cleanup

Archiving or deleting a workspace removes its worktree. Worktrees can still be
left behind by a failed cleanup or an older version. **Worktree Cleanup** in
**System** lists `workspace-*` folders under each project's worktree directory
that no non-archived workspace owns. Cleanup also protects configured project
repositories, including paths reached through symlinks or inside a candidate
folder. Standalone repositories, folders containing nested repositories
(including bare repositories), and linked worktrees whose owning repository
cannot be identified are never listed. An unreadable directory or unverifiable
Git registration is skipped and logged.

**Remove Orphaned Worktrees** asks for confirmation. Folders Git still tracks as
worktrees are removed through their owning repository with
`git worktree remove`; shared worktree directories are deduplicated and Git
locks remain effective. Other listed folders are deleted directly. Uncommitted
files are lost either way. Commits made in a linked worktree live in the project
repository and stay on their branch. The server re-checks which folders are
orphaned before removing anything and reports any folder it could not remove.
Removal is only available from a trusted local client.

## Factory configuration

The editor waits for the selected project's `factory-factory.json` query to
succeed. Loading and failed queries do not count as an absent configuration. A
failed query disables editing and offers **Retry**; a successful query that
finds no file allows creating one.

Use **Edit factory configuration** to edit the loaded scripts. If loading fails
while the editor is open, the editor closes to prevent saving stale scripts.
Save failures appear both in the editor and in an error toast; the editor stays
open so you can correct the configuration or retry.

## Server logs

Open **Server logs** at `/admin/logs`; the legacy `/logs` URL still works. The
page shares the settings breadcrumb and section navigation. Use the section
links to switch settings without returning to the general page.

Search messages or components, filter by log level or time range, and expand a
row to inspect its raw JSON. **Download log file** saves up to the most recent
10 MB of the server log. Navigation and filters remain available while entries
load; if loading fails, use **Retry** to request the logs again.

Relative log time ranges use minute boundaries and advance automatically while
the page polls every ten seconds. Rendering or expanding a log row does not
trigger another request. Custom date ranges keep their selected day boundaries.

## Voice mode

Voice, speed, sensitivity, and API-key changes save independently. Only the
**Enable voice mode** switch changes whether voice mode is enabled, so another
open tab can tune settings without overwriting that switch.
