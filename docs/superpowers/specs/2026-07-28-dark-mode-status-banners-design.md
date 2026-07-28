# Dark Mode Status Banners Design

## Problem

Workspace initialization banners use fixed Tailwind palette colors such as
`bg-red-50`, `bg-yellow-50`, and `bg-blue-50`. Those colors remain light in
dark mode, so error, warning, and informational banners look like light-theme
panels inside the dark workspace UI. The no-session workspace initialization
notice repeats the same light-only warning palette.

The rest of the banner audit found correctly themed examples that either use
semantic theme tokens or provide explicit dark-mode colors. Shared destructive
alerts already use the mode-aware `destructive` token, so they do not need a
separate visual redesign.

## Design

Add a small client utility that maps the banner kinds `error`, `warning`, and
`info` to semantic Tailwind classes:

- Error: `destructive`
- Warning: `warning`
- Info: `info`

Each mapping supplies a translucent semantic background, semantic border, and
semantic foreground. The existing CSS variables provide different values in
light and dark themes, so callers do not need local `dark:` overrides.

Use the utility in:

- The workspace chat initialization status banner, including runtime errors,
  setup warnings, and setup progress information.
- The empty-workspace initialization notice shown before the worktree exists.

Keep layout, icons, copy, and actions unchanged.

## Testing

Add a focused unit test for the semantic banner-style utility. The test will
assert the exact semantic mapping for all three banner kinds and reject
light-only fixed palette classes. Run the test before implementation to confirm
it fails because the utility does not exist, then run it after implementation
to confirm the mapping.

Render the affected workspace states in Storybook or the local app and inspect
them in both light and dark themes. Verify that:

- Error, warning, and info banners use a subtle theme-aware tint.
- Text and borders remain legible in both themes.
- Buttons and icons retain their existing layout.
- The empty-workspace initialization notice matches the warning treatment.

Finally run the full test suite, type checking, and repository checks before
publishing the pull request.

## Scope

This change fixes the two confirmed light-only banner implementations. It does
not rewrite unrelated diff colors, status dots, provider-specific branding, or
components that already define correct dark-mode styling.
