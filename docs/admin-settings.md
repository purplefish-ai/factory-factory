# Settings

Open Settings from the app navigation. General Settings includes IDE
preferences, chat defaults, and server logs. Appearance controls the color
scheme, text size, and fonts. Project Settings controls the selected project's
factory configuration and issue provider.

## Appearance

Appearance preferences are saved with the other user settings and apply on every
device that opens this server. Each change saves immediately.

- **Color scheme** picks a palette. Factory is the default; GitHub, One,
  Solarized, and High contrast are inspired by the corresponding editor themes.
  Every scheme has a light and a dark variant, chosen by **Mode** (or the
  sun/moon toggle in the sidebar). High contrast uses pure black and white with
  solid borders.
- **Background color** and **Text color** override the scheme's page background
  and primary text in both light and dark mode. Cards and secondary text are
  blended from the override so they stay readable. Use **Reset** next to a color
  to return to the scheme's own value.
- **Font size** scales the root font size from 75% to 175%. All text and spacing
  defined in `rem` follows it, including the terminal, independently of browser
  zoom.
- **Interface font** and **Monospace font** offer a few bundled stacks,
  including Atkinson Hyperlegible, plus **Custom** for any font installed on the
  device. A custom value is a CSS `font-family` list and may contain only
  letters, numbers, spaces, quotes, commas, periods, and hyphens.

**Reset appearance** returns every preference to its default. The last applied
appearance is cached in the browser so a reload does not flash the defaults
before the saved settings load.

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
older selection does not replace a newer selection, even when the same model is
selected again. Selectors stay disabled until the save and its settings refresh
finish. Delayed refreshes cannot replace a pending choice; later server changes
synchronize normally after saves settle.

## Factory configuration

The editor waits for the selected project's `factory-factory.json` query to
succeed. Loading and failed queries do not count as an absent configuration. A
failed query disables editing and offers **Retry**; a successful query that
finds no file allows creating one.

Use **Edit factory configuration** to edit the loaded scripts. If loading fails
while the editor is open, the editor closes to prevent saving stale scripts.
Save failures appear both in the editor and in an error toast; the editor stays
open so you can correct the configuration or retry.
