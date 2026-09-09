# Settings

Open Settings from the app navigation. General Settings includes IDE preferences,
chat defaults, and server logs. Project Settings controls the selected project's
factory configuration and issue provider.

## Custom IDE commands

Select **Custom** under **Preferred IDE** to reveal the command field. For a new
custom IDE, the saved preference remains unchanged until a nonempty command is
saved successfully. Enter a command such as `code-insiders {workspace}`, then
leave the field to save it. The command must include `{workspace}` and pass the
server's command validation. A rejected save leaves the field available to edit.

**Test** runs the command currently in the field. Choosing Cursor or VS Code
preserves the saved custom command for later use.

## Chat defaults

Model selections save immediately. If a save fails, the affected model selector
returns to the saved value and an error toast appears. A late failure from an
older selection does not replace a newer selection.

## Factory configuration

The editor waits for the selected project's `factory-factory.json` query to
succeed. Loading and failed queries do not count as an absent configuration.
A failed query disables editing and offers **Retry**; a successful query that
finds no file allows creating one.

Use **Edit factory configuration** to edit the loaded scripts. If loading fails
while the editor is open, the editor closes to prevent saving stale scripts.
Save failures appear both in the editor and in an error toast; the editor stays
open so you can correct the configuration or retry.
