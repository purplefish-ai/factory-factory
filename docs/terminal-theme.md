# Terminal theme

Terminals and setup logs follow the selected appearance preset, light or dark
mode, and custom foreground/background overrides. Existing terminal buffers and
sessions survive changes to appearance: the renderer updates xterm's theme in
place rather than recreating the terminal.

The ANSI red, green, yellow, blue and magenta slots use the destructive,
success, warning, info and merged theme tokens. Cyan blends the blue and green
hues; bright variants move toward the foreground. ANSI black and white use the
darker and lighter of the preset's foreground/background pair, preserving their
meaning when programs use them as backgrounds. Bright black uses muted text.
Cursor and selection colors follow the text and background. Xterm enforces a
minimum text contrast of 4.5:1, raised to 7:1 for High contrast, including
application-supplied ANSI colors. Programs supplying explicit true-color or
indexed colors retain those colors, subject to xterm's contrast adjustment.

The `Workspace/TerminalInstance` palette stories show normal and bright ANSI
colors, text selection, and light/dark and High contrast states. Use the toolbar
to change the preset while the terminal is mounted and confirm its output stays
in place. Terminal tabs, empty states, disconnect notices and setup output use
the same theme tokens as the rest of the workspace.
