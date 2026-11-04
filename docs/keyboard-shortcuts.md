# Keyboard shortcuts

Press `?` outside a text field to open the keyboard reference. Search (`⌘K` on
macOS, `Ctrl+K` elsewhere) also lists commands available on the current screen.
Commands share handlers with keyboard shortcuts and the desktop app menu.

- `⌘B` / `Ctrl+B`: toggle the sidebar.
- `Alt+↑` / `Alt+↓`: previous / next workspace in sidebar order.
- `Alt+Shift+↓`: next workspace that needs input or attention.
- `Alt+[` / `Alt+]`: previous / next chat.
- `/`: focus the composer, while outside a text field.
- `Alt+Shift+P`: toggle planning; `Alt+Shift+E`: toggle thinking; `Alt+Shift+Q`:
  open quick actions when those controls are available.

The browser keeps `⌘⇧T`, `⌘⇧A`, `Ctrl+Shift+P`, and `Ctrl+Tab`. The desktop app
additionally retains its original composer shortcuts and uses `Ctrl+Tab` for
chat switching. Its native menu supplies Settings (`⌘,` / `Ctrl+,`) and New
workspace (`⌘N` / `Ctrl+N`).

Tab bars have one Tab stop. Left/Right and Home/End move focus; Enter/Space
select the focused tab. Delete (the Mac Backspace key) closes a focused chat,
with the existing confirmation when it has active work or queued messages. Close
controls sit beside their tabs, never inside the tab control.

Plain keys yield to text fields, interactive widgets and modal dialogs.
Workspace arrow shortcuts yield to text fields so native paragraph navigation
continues to work. Navigation keys yield to terminals; search and sidebar
toggling remain available there. Review approval requires Shift+A; modifier
combinations such as `⌘D` do not invoke review actions.

Definitions live in `src/client/lib/shortcut-definitions.ts`; matching, platform
labels and context guards are in `keyboard-shortcuts.ts`. Feature handlers
register through `useShortcut` from the shortcuts feature. The help sheet,
tooltips, accessible key labels and command palette use those same definitions.
Add a registry definition and context tests when adding a shortcut.
