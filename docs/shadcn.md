# Maintaining shadcn components

Refreshed on 2026-09-09 against the official
[new-york-v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json),
using the matching component JSON for each retained primitive. These are source
copies, so updating package versions alone does not update the wrappers.

The refresh brings React 19 ref props, data-slot attributes, focus and
invalid-state styling, range slider thumbs, dialog close controls, command
dialog accessible labels, calendar sizing and week-number range styling, and
current toast styling.

## Local adaptations

- Keep individual `@radix-ui/react-*` imports. The upstream `radix-ui` umbrella
  would install primitives removed by the dependency cleanup.
- Use Phosphor icons and the existing `@/lib/utils` helper. Do not add Lucide or
  the upstream `cn` package. `components.json` records the Phosphor preference.
- Keep the application theme, compact cards and dialog/sheet spacing, semantic
  success/warning/info/danger badges (tinted with the status chip classes,
  following [status colors](status-colors.md)), the Badge `count` size, tooltip
  delay/offset, and full-width popper selects. The upstream `Alert` is not
  installed: messages use the app's `StatusCallout`.
- Keep default sizes overridable through `className`; data-state and responsive
  size selectors must not override compact controls or wide attachment dialogs.
  Alert actions merge caller classes through Button to retain destructive
  styling.
- Dialogs and sheets honor reduced-motion preferences. Sheets open in 200ms and
  close in 150ms, faster than upstream. Command dialog titles and descriptions
  belong inside the modal so outside-content hiding does not hide their
  accessible labels.
- ScrollArea retains `viewportRef`, viewport `onScroll`, `smoothScroll`,
  both-axis scrollbars and hover visibility on fine-pointer devices. Touch
  scrollbars remain visible while mounted. File and diff viewers depend on
  these.
- Sidebar retains localStorage/cookie persistence, its 18rem width, full-width
  mobile layout, keyboard shortcut, and application height/overflow behavior.
  Its CSS variable utilities now use Tailwind 4 syntax.
- Resizable retains layout persistence, direction compatibility, and handle hit
  targets. InputGroup retains native fieldset semantics and the compact focus
  treatment; Spinner retains its brand color. App-specific markdown, Mermaid,
  confirmation dialogs, prompt cards and tab buttons are not registry
  components.
- Calendar uses `@daypicker/react` v10, retaining the package migration from
  main.
- Slider thumb keys follow positions rather than changing values, preserving
  focus during controlled updates. Omitted values retain Radix's single-thumb
  default, and thumb surfaces use the application background in both themes.
- Menu inset attributes are present only when enabled. Keep semantic popover
  headings, visible tab-panel focus rings, and the existing sheet title size.

## Buttons, icon buttons and tooltips

`Button`'s `size` variant sets both the button's dimensions and its icon size,
so icons inside a `Button` carry no size classes. Its
`[&_svg:not([class*='size-'])]` selector outranks `h-*`/`w-*` utilities, so an
`h-3 w-3` icon class would be silently ignored; only a `size-*` class opts out,
and only a deliberate exception should use one.

| Size                       | Height | Icons | Use                                               |
| -------------------------- | ------ | ----- | ------------------------------------------------- |
| `xs` / `icon-xs`           | 24px   | 12px  | Dense row and card actions                        |
| `compact` / `icon-compact` | 28px   | 14px  | Toolbars, composer controls, pane headers         |
| `sm` / `icon-sm`           | 32px   | 16px  | Header controls and secondary actions             |
| `default` / `icon`         | 36px   | 16px  | Forms and dialogs                                 |
| `lg` / `icon-lg`           | 40px   | 16px  | Prominent calls to action                         |
| `inline`                   | auto   | 16px  | Text actions within a line, with `variant="link"` |

`compact` is a local addition for the 28px controls the dense layouts already
used. Layout widths (`w-full`, `sm:w-auto`, `max-w-*`) stay in `className`;
heights and widths do not. On coarse pointers `src/client/globals.css` raises
every button to a 36px minimum target.

An icon-only button with a tooltip is `IconButton` from
`src/client/components/icon-button.tsx`: its `label` is both the accessible name
and the tooltip, `tooltip` takes richer content such as a shortcut, and it
forwards props and its ref, so it works inside `DropdownMenuTrigger asChild`. A
disabled button takes no pointer events, so its tooltip only shows while it is
enabled; `tooltipWhileDisabled` opens it from a wrapper span instead, as the
chat Stop button does while stopping. Icons sit directly in the button with no
horizontal margin: the size variant's `gap` spaces icon and label. Tooltips
render under one `TooltipProvider` at the app root (`AppLayout`,
`delayDuration={0}`; the sidebar's provider uses the same delay). A nested
provider without props would reset the open delay to Radix's 700ms default, so
only the roots, fixture routes and the GitHub link preview (a deliberate 350ms
delay) render one; `.oxlintrc.json` lists each exception and its reason. Tests
that mount a component directly wrap it in a provider.

Raw `<button>`s are for rows, overlay hit targets and primitive internals. Their
keyboard focus uses the `focus-ring` utility from `src/client/globals.css` (add
`focus-visible:ring-inset` where an outer ring would be clipped). Pressed
toggles use `Toggle`.

The `factory/button-icon-size`, `factory/button-size-variant`,
`factory/icon-button-tooltip`, `factory/tooltip-provider-root` and
`factory/focus-ring` lint rules enforce this
([lint guardrails](../lint-rules/README.md)).

## Touch and keyboard action visibility

Secondary actions use the `hover-reveal` utility from `src/client/globals.css`.
It hides actions only at desktop widths with a fine pointer, hover support, and
no coarse pointer (the shared `mouse-only` variant), and reveals them when their
parent `group` is hovered or contains keyboard focus. On touch devices
(including wide tablets) and narrow screens, actions remain visible, including
hybrid devices with both touch and a mouse. Sidebar action hit-area expansion
follows the same rule. Use this for card, message, screenshot and tab actions
rather than unconditional `opacity-0` or width-only hover rules. Named sidebar
and scrollbar groups use equivalent pointer media queries.

The `Shared/HoverActions` Storybook story and
`pnpm test:e2e:mobile e2e/hover-actions.spec.ts` exercise these states.

## CSS and dependencies

Vite and Storybook use `@tailwindcss/vite`; there is no parallel PostCSS
pipeline or legacy JavaScript Tailwind configuration. CSS uses `tw-animate-css`
alone. Typography and animation CSS packages are development dependencies
because Vite compiles their output into the distributed frontend. The PostCSS
security override still applies to transitive versions.

Removed 18 unused catalog files and 15 direct dependencies, including their Knip
exclusions. Generate components when needed instead of retaining an unused
catalog.

## Future refreshes

Use the [CLI diff workflow](https://ui.shadcn.com/docs/cli) to inspect changes:

```sh
pnpm dlx shadcn@latest add button --diff
```

Review and merge changes with the local adaptations above. Do not blindly
overwrite all wrappers or switch component libraries. Keep `rsc: false` and omit
Next.js client/server directives.

Run the root AGENTS.md checks, `pnpm knip`, `pnpm build`, and
`pnpm build:storybook`. The `UI/Primitives`, `UI/Button`, `UI/Badge`, and
`UI/Dialog` stories cover the refreshed controls. `UI/PrimitivesAccessibility`
adds browser regressions for menu padding, keyboard focus, themed sliders, and
sheet headings. Check light/dark themes, narrow screens, keyboard interaction,
overlays, and reduced motion. The co-located primitive and persistence tests
protect behavioral contracts.
