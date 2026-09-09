# Maintaining shadcn components

Refreshed on 2026-09-09 against the official
[new-york-v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json),
using the matching component JSON for each retained primitive. These are source
copies, so updating package versions alone does not update the wrappers.

The refresh brings React 19 ref props, data-slot attributes, focus and invalid-state
styling, range slider thumbs, dialog close controls, command dialog accessible
labels, calendar sizing and week-number range styling, and current toast styling.

## Local adaptations

- Keep individual `@radix-ui/react-*` imports. The upstream `radix-ui` umbrella
  would install primitives removed by the dependency cleanup.
- Use Phosphor icons and the existing `@/lib/utils` helper. Do not add Lucide or
  the upstream `cn` package. `components.json` records the Phosphor preference.
- Keep the application theme, compact cards and dialog/sheet spacing, semantic
  success/warning/info badges, tooltip delay/offset, and full-width popper selects.
- Keep default sizes overridable through `className`; data-state and responsive
  size selectors must not override compact controls or wide attachment dialogs.
  Alert actions merge caller classes through Button to retain destructive styling.
- Dialogs and sheets honor reduced-motion preferences. Command dialog titles and
  descriptions belong inside the modal so outside-content hiding does not hide
  their accessible labels.
- ScrollArea retains `viewportRef`, viewport `onScroll`, `smoothScroll`, both-axis
  scrollbars and hover visibility. File and diff viewers depend on these.
- Sidebar retains localStorage/cookie persistence, its 18rem width, full-width
  mobile layout, keyboard shortcut, and application height/overflow behavior.
  Its CSS variable utilities now use Tailwind 4 syntax.
- Resizable retains layout persistence, direction compatibility, and handle hit
  targets. InputGroup retains native fieldset semantics and the compact focus
  treatment; Spinner retains its brand color. App-specific markdown, Mermaid,
  confirmation dialogs, prompt cards and tab buttons are not registry components.
- Calendar uses `@daypicker/react` v10, retaining the package migration from main.
- Slider thumb keys follow positions rather than changing values, preserving
  focus during controlled updates.

## CSS and dependencies

Vite and Storybook use `@tailwindcss/vite`; there is no parallel PostCSS pipeline
or legacy JavaScript Tailwind configuration. CSS uses `tw-animate-css` alone.
Typography and animation CSS packages are development dependencies because Vite
compiles their output into the distributed frontend. The PostCSS security override
still applies to transitive versions.

Removed 18 unused catalog files and 15 direct dependencies, including their Knip
exclusions. Generate components when needed instead of retaining an unused catalog.

## Future refreshes

Use the [CLI diff workflow](https://ui.shadcn.com/docs/cli) to inspect changes:

```sh
pnpm dlx shadcn@latest add button --diff
```

Review and merge changes with the local adaptations above. Do not blindly overwrite
all wrappers or switch component libraries. Keep `rsc: false` and omit Next.js
client/server directives.

Run the root AGENTS.md checks, `pnpm knip`, `pnpm build`, and
`pnpm build:storybook`. The `UI/Primitives`, `UI/Button`, `UI/Badge`, and `UI/Dialog`
stories cover the refreshed controls. Check light/dark themes, narrow screens,
keyboard interaction, overlays, and reduced motion. The co-located primitive and
persistence tests protect behavioral contracts.
