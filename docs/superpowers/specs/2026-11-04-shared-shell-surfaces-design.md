# Shared shell surfaces

Approved direction: give the title bar, sidebar, and pane/tab headers one
continuous surface while preserving distinct content areas. Keep navigation,
window dragging, and native controls. Restore the installed-app header boundary
with the navigation collapsed or expanded, and improve dark-mode separation.

Use a theme-relative shell token: the existing title-bar tint in light mode and
a slightly lighter tint in dark mode. Keep preset hues and high-contrast mode.
Share preset sidebar surfaces with the header and tabs; slightly lift the
Solarized light surface so header text stays above 4.5:1 contrast. Keep
selected-row metadata at 4.5:1, including One and Solarized light palettes.
Strengthen the default dark border token so pane boundaries remain visible.

Alternatives considered: only restoring the line leaves inconsistent surfaces;
using one color for content too loses pane hierarchy; removing header controls
loses navigation. The user approved shared surrounding surfaces and separators.

Verify rendered colors and boundaries in light/dark, expanded/collapsed
navigation, native-controls previews, phone layouts, and appearance presets.
Changes ship in a separate PR, with no automatic merge or replies to review
comments.
