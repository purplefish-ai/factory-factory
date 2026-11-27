# Keyboard shortcuts

Press `?` outside a text field to open the keyboard reference. Search (`⌘K` on
macOS, `Ctrl+K` elsewhere) also lists commands available on the current screen.
Commands share handlers with keyboard shortcuts.

- `⌘B` / `Ctrl+B`: toggle the sidebar.
- `Alt+↑` / `Alt+↓`: previous / next workspace in sidebar order.
- `Alt+Shift+↓`: next workspace that needs input or attention.
- `Alt+[` / `Alt+]`: previous / next chat.
- In a focused terminal on macOS, Option+Left and Option+Right move by a word in
  shells that bind Meta+B and Meta+F to word movement.
- `/`: focus the composer, while outside a text field.
- `Alt+Shift+P`: toggle planning; `Alt+Shift+E`: toggle thinking; `Alt+Shift+Q`:
  open quick actions when those controls are available.

The browser keeps `Mod+Shift+P`, `Mod+Shift+T`, `Mod+Shift+A` and `Ctrl+Tab`
(`Mod` means Command on macOS and Ctrl elsewhere).

Tab bars have one Tab stop. Left/Right and Home/End move focus; Enter/Space
select the focused tab. Delete (the Mac Backspace key) closes a focused tab when
it offers a close action, with the existing confirmation when it has active work
or queued messages. Close controls sit beside their tabs, never inside the tab
control. Selection tab bars (workspace chats and open files, quick-chat
sessions, desktop right-panel tools, log sources, and Logs with the terminals)
render `TabList` and `TabButton` from
[`tab-button.tsx`](../src/components/ui/tab-button.tsx), which own this
behavior. Tabs that switch panels, such as the PR detail panel and the mobile
tool switcher, use the shadcn `Tabs` (Radix). `factory/no-raw-tab-role` rejects
`role="tab"` and `role="tablist"` written anywhere else
([rule](../lint-rules/rules/no-raw-tab-role.mjs)).

Plain keys yield to text fields, typeahead widgets and modal dialogs; `?` and
`/` remain available on ordinary buttons and links. Workspace arrows and
Alt-bracket chat shortcuts yield to text fields so native paragraph navigation
and punctuation entry continues to work. Navigation keys yield to terminals;
search and sidebar toggling remain available there. Review approval requires
Shift+A; modifier combinations such as `⌘D` do not invoke review actions.

Definitions live in `src/client/lib/shortcut-definitions.ts`; matching, platform
labels and context guards are in `keyboard-shortcuts.ts`. Feature handlers
register through `useShortcut` from the shortcuts feature. The help sheet,
tooltips, accessible key labels and command palette use those same definitions.
Add a registry definition and context tests when adding a shortcut.
