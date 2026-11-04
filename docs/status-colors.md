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
block also matches `.dark` descendants, so an always-dark surface inside a light
page (the terminal disconnect banner) uses the selected scheme's dark palette;
the test also requires dark blocks to redeclare every light-block token. Presets
keep their own focus ring, which follows their accent color. Preset gray text
(`muted-foreground`) follows the source themes; Solarized's grays fall slightly
below AA on cards.

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
[`status-indicators.tsx`](../src/client/components/status-indicators.tsx), or
with `getStatusToneStyle(tone)` classes. Tinted chips and banners use
`bg-<token>-accent/15` with `text-<token>` in light mode and `bg-<token>/10` in
dark mode; the Badge `success`, `warning` and `info` variants follow the same
rule.

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
- `terminal-panel.tsx`, `terminal-tab-bar.tsx`, `init-output-panel.tsx` and
  `workspace-overlays.tsx`: the terminal and terminal-like log surfaces stay
  dark zinc to match xterm's fixed palette in `terminal-instance.tsx`. Status UI
  on the terminal, such as `terminal-disconnect-banner.tsx`, lives in separate
  files that use dark-scoped tokens and stay under the rule.
- `workspace-header-pwa-preview.tsx`: mock macOS window controls reproduce the
  operating system's red, yellow and green.

`src/backend/testing/oxlint-factory-rules.test.ts` runs the rule through the
Oxlint binary and fails when an exception no longer contains raw classes. Add an
exception only for color that is not a status and has no theme token, and give
its reason in the option.

## Not yet themed

Mermaid diagrams use Mermaid's default theme, chat prose uses the typography
plugin's colors, and the terminal uses a fixed zinc palette. These are tracked
in #2935.

## Board controls and PR states

Desktop workspace creation lives at the top of Todo, alongside the inline
composer. Phones retain a header shortcut that reveals Todo from any tab. The
board overflow menu offers **Sync now** for an explicit forced PR sync and
workspace/issue refresh; normal updates remain automatic.

Board cards keep one workspace status label. Attached PR states appear as icons
with tooltips available on hover and keyboard focus. Each distinct state has an
icon, repeated states show a count, and tooltips list their PR numbers. The PR
menu continues to expose individual PR actions and details. The desktop sidebar
preserves its open/closed preference across navigation.
