# Status colors

Status color comes from theme tokens, never from Tailwind's fixed palette, so
one state looks the same everywhere and follows the selected color scheme. The
tokens live in [`globals.css`](../src/client/globals.css) and are overridden per
preset in [`theme-presets.css`](../src/client/theme-presets.css). The
`Foundations/Colors` and `Foundations/StatusPalette` Storybook stories show
every token and tone with live contrast for the selected theme and scheme.

## Tokens

| Token         | Meaning                                    | Factory light | Factory dark       |
| ------------- | ------------------------------------------ | ------------- | ------------------ |
| `running`     | An agent or process is actively working    | brand gold    | brand yellow       |
| `success`     | Passed, approved, ready, open PR           | green         | green              |
| `warning`     | Caution and "needs you"                    | burnt orange  | amber              |
| `destructive` | Failed, error, changes requested, closed   | red           | red                |
| `info`        | Waiting on something else, informational   | blue          | blue               |
| `merged`      | Merged pull requests                       | purple        | purple             |
| `brand`       | Factory Yellow accent (not a status)       | gold, hue 95  | `#FFE500`, hue 102 |
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

Light mode cannot use bright yellow as text, so its brand is Factory Yellow's
hue darkened to a gold. `running` follows `brand` in the Factory scheme.

### Presets

Each preset declares all status tokens in both its light and dark blocks, using
its source palette's own hues (Primer, One, Solarized) adjusted where needed for
contrast. A light-block declaration outranks `.dark`, so a preset must redeclare
every status token in its dark block; the palette test checks this. Presets keep
their own focus ring, which follows their accent color. Preset gray text
(`muted-foreground`) follows the source themes; Solarized's grays fall slightly
below AA on cards.

## Tones

[`status-tones.ts`](../src/client/lib/status-tones.ts) is the one presentation
map. It extends `WorkspaceStatusReasonTone` from
`src/shared/workspace-status-reason.ts` with message and PR tones and maps each
tone to a token, classes for text, dot, chip, banner and border, and an icon:

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
`bg-<token>/10` with `text-<token>`; the Badge `success`, `warning` and `info`
variants follow the same rule.
