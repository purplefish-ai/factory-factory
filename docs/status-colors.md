# Status colors

Status color must come from theme tokens, never from Tailwind's fixed palette,
so one state looks the same everywhere and follows the selected color scheme.
The tokens live in [`globals.css`](../src/client/globals.css) and are overridden
per preset in [`theme-presets.css`](../src/client/theme-presets.css). The
`Foundations/Colors` and `Foundations/StatusPalette` Storybook stories show
every token and tone with live contrast for the selected theme and scheme.

## Tokens

| Token         | Meaning                                    | Factory light | Factory dark       |
| ------------- | ------------------------------------------ | ------------- | ------------------ |
| `running`     | An agent or process is actively working    | deep amber    | brand yellow       |
| `success`     | Passed, approved, ready, open PR           | green         | green              |
| `warning`     | Caution and "needs you"                    | burnt orange  | amber              |
| `destructive` | Failed, error, changes requested, closed   | red           | red                |
| `info`        | Waiting on something else, informational   | blue          | blue               |
| `merged`      | Merged pull requests                       | purple        | purple             |
| `brand`       | Factory Yellow accent (not a status)       | amber, hue 75 | `#FFE500`, hue 102 |
| `ring`        | Focus rings; neutral so it is never status | gray          | gray               |

Each status token is a text and icon color. It reaches WCAG AA (4.5:1) on the
page background, cards and its own 10% tint, in every scheme and mode; the High
contrast scheme reaches 7:1 on backgrounds. `src/client/status-palette.test.ts`
parses the theme CSS and enforces these ratios.

`*-foreground` always means the text color on a solid fill of its token, in both
modes: light text on the darker light-mode fills, dark text on the brighter
dark-mode fills. Destructive is the one exception in dark mode, where the shadcn
Button and Badge render it at 60% opacity with light text. Do not use
`*-foreground` for text on a tint; use the base token.

Light mode uses deep amber for readable running text. Separate `*-accent` tokens
provide vivid colors for borders and 15% chip/banner tints; Factory's running
accent is bright yellow. Dark mode keeps the existing 10% tints and uses the
base status colors as accents. Each preset supplies its own accents, and the
palette test checks text contrast on these tints too. Standalone status dots
keep the contrast-safe base colors. Active board cards retain a clean light-mode
surface and accent border; dark mode retains its running tint.

### Presets

Each preset declares all status tokens in both its light and dark blocks, using
its source palette's own hues (Primer, One, Solarized) adjusted where needed for
contrast. A light-block declaration outranks `.dark`, so a preset must redeclare
every status token in its dark block; the palette test checks this. Each dark
block also matches `.dark` descendants, so a nested dark preview inside a light
page uses the selected scheme's dark palette; the test also requires dark blocks
to redeclare every light-block token. Presets keep their own focus ring, which
follows their accent color. Preset gray text (`muted-foreground`) follows the
source themes with lightness adjusted to meet AA on page, card and muted
surfaces.

## Tones

[`status-tones.ts`](../src/client/lib/status-tones.ts) is the one presentation
map. It extends `WorkspaceStatusReasonTone` from
`src/shared/workspace-status-reason.ts` with message tones and maps each tone to
a token, classes for text, dot, chip, banner and border, and an icon:

| Tone        | Token              | Used for                                  |
| ----------- | ------------------ | ----------------------------------------- |
| `neutral`   | `muted-foreground` | Idle, draft, unknown, archived            |
| `working`   | `running`          | Live agent or setup work (the only pulse) |
| `waiting`   | `info`             | CI running, checking a PR, queued updates |
| `attention` | `warning`          | Permission, plan approval, questions      |
| `success`   | `success`          | Passing CI, approvals, ready to merge     |
| `warning`   | `warning`          | Caution messages                          |
| `danger`    | `destructive`      | Failures, errors, changes requested       |
| `info`      | `info`             | Informational messages                    |
| `merged`    | `merged`           | Merged pull requests                      |

`attention` shares the warning token: both ask the user to act, and the other
distinct hues are taken by running, danger, success, waiting and merged. Icons
and labels distinguish them. Pull request states follow GitHub (open green,
draft neutral, merged purple, closed red) through `getPrStatePresentation`;
`getCiStateTone` maps the combined CI state.
[`pr-status-presentation.ts`](../src/client/lib/pr-status-presentation.ts) adds
readable labels and tones for review decisions, reviews, merge states and
individual checks, so review surfaces never show raw GitHub enums. Diff
statistics use `DIFF_STAT_CLASS_NAMES` (success and destructive text).

Render statuses with `StatusDot`, `StatusIcon` and `StatusChip` from
[`status-indicators.tsx`](../src/client/components/status-indicators.tsx), and
messages with `StatusCallout`, rather than with `getStatusToneStyle(tone)`
classes. Tinted chips and callouts use `bg-<token>-accent/15` with
`text-<token>` in light mode and `bg-<token>/10` in dark mode; the Badge
`success`, `warning`, `info` and `danger` variants reuse the chip classes.

## Callouts and chips

Each kind of status surface has one component:

| Need                                     | Use                                                      |
| ---------------------------------------- | -------------------------------------------------------- |
| An error, warning, success or info box   | `StatusCallout` (`src/client/components/status-callout`) |
| A status word on a card, row or PR panel | `StatusChip`                                             |
| A number beside a nav item, tab or title | `Badge size="count"` (`secondary`, `outline` or a tone)  |
| A progress or usage bar                  | `Progress` (`src/components/ui/progress.tsx`)            |
| A query that failed                      | `QueryErrorState` / `QueryRefreshError` (both callouts)  |

`StatusCallout` takes a `tone`, an optional `icon` (the tone's icon by default,
a specific Phosphor icon, an element such as `Spinner`, or `false`), a
medium-weight `title`, the message as children and trailing `action` controls,
which wrap under the message in narrow containers. `variant="card"` is a rounded
box; `variant="strip"` spans the top of a pane with only a bottom border.
`size="sm"` uses `text-xs` for dense panels. All callout text uses the tone
color: the palette test checks it on every tone's surface, while the foreground
color falls below AA on some tints (Solarized). Pass `role="alert"` for an error
raised by an action and `role="status"` for a polite live update.

`StatusChip` uses `text-2xs` at its default `sm` size and `text-xs` at `md`,
with an optional tone icon, and passes span attributes through (`title`, `role`,
`aria-label`). `CiStatusChip`, `PrStateBadge`, `KanbanStatusChip` and
`UnreadMailBadge` render it.

## Small text

`text-2xs` (11px with a 14px line, in the `@theme` block of
[`globals.css`](../src/client/globals.css)) is the one step below `text-xs`, for
chips, section labels and dense metadata such as card and sidebar rows. It
replaces the former mix of `text-[10px]` and `text-[11px]`: the two were used
interchangeably for the same roles (uppercase labels used both), a 1px
difference is not a distinguishable step in the scale, and 11px keeps uppercase
labels and chips legible. `SectionLabel`
([`section-label.tsx`](../src/client/components/section-label.tsx)) is the
uppercase, tracked, muted `text-2xs` heading for groups of rows and menu groups;
pass `asChild` to style a heading or `SelectLabel`. The `Foundations/Typography`
`TypeScale` story shows the scale.

## Lint guard

`factory/no-raw-palette-classes` (in
[`lint-rules/factory.mjs`](../lint-rules/factory.mjs)) rejects Tailwind color
utilities with a fixed palette hue and shade, such as `bg-red-500`,
`dark:text-emerald-300` or `hover:border-sky-500/40`, in string and template
literals under `src/client`, `src/components` and `src/lib`. Theme tokens,
`white` and `black` pass. Tests are exempt so they can assert that raw classes
are absent.

The remaining exceptions are the rule's `exceptions` option in
[`.oxlintrc.json`](../.oxlintrc.json), a map from each path to its reason:

- `subagent-icon.tsx`: twelve categorical identity hues that tell subagents
  apart. They are not statuses, so they cannot map onto status tokens.
- `workspace-header-pwa-preview.tsx`: mock macOS window controls reproduce the
  operating system's red, yellow and green.

`src/backend/testing/oxlint-factory-rules.test.ts` runs the rule through the
Oxlint binary and fails when an exception no longer contains raw classes. Add an
exception only for color that is not a status and has no theme token, and give
its reason in the option.

`factory/use-status-callout` rejects a class string that pairs a tinted status
background (`bg-warning/10`, `dark:bg-info-accent/15`) with a border of the same
status token (`border-warning/30`, `border-b-warning/20`), the shape of a
hand-rolled callout. Only unprefixed and `dark:` classes count, so hover, focus
and data-state tints pass, as do a tint without a status border and mixed
tokens. It checks each string on its own, so classes split across `cn()`
arguments are not caught. Its exceptions are the tone map and status-carrying
board cards and sidebar rows, which tint a whole item rather than show a
message. `factory/no-arbitrary-font-size` rejects `text-[10px]`, `text-[0.8rem]`
and other arbitrary font sizes in favor of the type scale; its exceptions are
the shadcn calendar and files whose remaining arbitrary size is pending another
change. Both rules take the same `exceptions` map, skip tests, and have the same
stale-exception check.

## Content surfaces

Markdown prose keeps the typography plugin's layout while mapping its colors to
active theme tokens in `src/client/prose.css`. Body text, headings, quotes and
code use the foreground; links use the primary color, and secondary details use
the muted foreground. The mapping applies to both Markdown renderers and plain
prose wrappers, including live custom appearance overrides. The
`Foundations/Typography` stories cover every preset and mode.

Mermaid diagrams resolve the active theme tokens to sRGB colors before
rendering. Mounted diagrams rerender when the mode, preset or custom colors
change. Mermaid configuration and rendering run in one queue because its
configuration is global; chart directives cannot override the application's
theme or strict security settings. The `Chat/Transcript/MermaidDiagram` stories
cover flowcharts, class, state, sequence, pie, Gantt and mindmap diagrams.

Terminals and setup logs follow the selected theme too. Xterm updates its
palette in place, preserving existing output and sessions, and enforces a
minimum text contrast of 4.5:1 (7:1 in High contrast). ANSI colors derive from
the semantic status tokens; see [terminal theme](terminal-theme.md) for palette
details and Storybook coverage. Terminal surfaces no longer need raw-palette
lint exceptions.

## Board controls and PR states

Desktop workspace creation lives at the top of Todo, alongside the inline
composer. Phones retain a main-pane toolbar shortcut that reveals Todo from any
tab. The board overflow menu offers **Sync now** for an explicit forced PR sync
and workspace/issue refresh; normal updates remain automatic.

Board cards keep one workspace status label. Attached PR states appear as icons
with tooltips available on hover and keyboard focus. Each distinct state has an
icon, repeated states show a count, and tooltips list their PR numbers. The PR
menu continues to expose individual PR actions and details. The desktop sidebar
preserves its open/closed preference across navigation.

## Accessibility and offline defaults

Muted text meets WCAG AA (4.5:1) against page, card and muted surfaces in all
presets and both modes, including labels using `text-muted-foreground/80`. The
status palette test guards these combinations. It also checks that Factory muted
fills remain distinct from the page background. Pane headers use the separate
`--shell` token. Use shared tokens rather than adjusting contrast per component.
Compact CI and child workspace indicators use distinct status icons with
accessible labels, so their meaning survives monochrome display.

Geist and Geist Mono variable fonts are served locally, including in Storybook,
so default text remains available offline. The assets and SIL Open Font License
are in `public/fonts/geist`, sourced from `vercel/geist-font` commit
`a2357c1398c81d88ff84823a2f50af3152ee8733`. The optional Appearance families
(Inter, IBM Plex Mono, Atkinson Hyperlegible Next and Mono) are also served
locally from `public/fonts/<family>`, each with its license, using the
Fontsource 5.3.0 builds of Google Fonts' unicode-range subsets. Their
`@font-face` rules in `src/client/fonts.css` load with the app stylesheet, but
the browser fetches a font file only when text uses that family and falls in its
range, and the app loads no third-party stylesheet before first paint.
`src/client/fonts.test.ts` fails if a preset names a web font that is not
bundled or if `index.html` gains a cross-origin resource.

Icon buttons and close controls have 36px minimum targets on devices with any
coarse pointer. Targets participate in layout rather than extending over nearby
actions. The thinking footer reserves the same minimum height; composer actions
wrap when they cannot fit in one row. Bottom sheets include the device safe-area
inset in addition to their normal padding; chat composers already use the shared
safe-area helper. Looping spinners and pulses remain static when reduced motion
is requested.
