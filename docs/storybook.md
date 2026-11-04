# Storybook

Storybook is the review surface for UI changes. Every changed component state
should have a story that a reviewer can open without a backend. Run it with
`pnpm storybook` (port 6006); `pnpm build:storybook` is the CI build.

## Where stories live

- Co-locate `name.stories.tsx` next to the component it covers. Storybook loads
  `src/components/ui/**` and `src/client/**` (see `.storybook/main.ts`).
- Put story-only data in a sibling `name.story-fixtures.ts` when several stories
  or tests share it, as with `kanban-card.story-fixtures.ts`.
- Frontend-only regression surfaces that compose several features live in
  `src/client/routes/*-fixture.tsx`. A fixture may have its own story and may
  also back a `/__mobile-baseline` Playwright route.

## Titles

Every story file sets an explicit `title`. The first segment is one of these
groups, which the sidebar shows in this order (`parameters.options.storySort` in
`.storybook/preview.ts`):

| Group         | Covers                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Foundations` | Design tokens and palettes, such as colors and status colors.                                                      |
| `UI`          | shadcn/ui primitives in `src/components/ui`.                                                                       |
| `Shared`      | App components in `src/client/components` that no single area owns, plus cross-feature fixtures.                   |
| `Navigation`  | Sidebar, app and project headers, search, and project/workspace switchers.                                         |
| `Board`       | The Kanban board, columns, cards, and launch forms.                                                                |
| `Workspace`   | Workspace detail: header controls, panels, files, diffs, terminal, dialogs, overlays, inbox, and child workspaces. |
| `Chat`        | Transcript, composer, prompts, tool renderers, session tabs, usage, and subagents.                                 |
| `Agents`      | The Agents dashboard and event agents.                                                                             |
| `Reviews`     | PR review dashboard, PR panels, and CI status.                                                                     |
| `Projects`    | Project creation and project configuration forms.                                                                  |
| `Settings`    | Admin settings sections and integrations such as Slack, Codex accounts, and voice.                                 |

`Chat` uses sub-groups because it is the largest area: `Chat/Transcript`,
`Chat/Input`, `Chat/Prompts`, `Chat/Tools`, `Chat/Sessions`, `Chat/Subagents`,
and `Chat/UsageStats`. Add a sub-group elsewhere only when a group gains several
closely related components; prefer a flat list otherwise.

Choose the group by where the user sees the component, not by the source folder.
For example, the composer's `ImageDropZone` lives in `src/client/components` but
is titled `Chat/Input/ImageDropZone`.

The leaf is the PascalCase name of the component under test, such as
`Workspace/FileViewer`. Name stories after the state they show
(`export const LoadingAppearance`); Storybook displays export names in sentence
case.

There is no `Pages` group. A full-page composition belongs to its domain with a
`Page` suffix (`Reviews/ReviewsPage`, `Projects/NewProjectPage`,
`Settings/LogsPage`), so a page sits next to the panels it composes. Responsive
behavior is a story state, not a group: add a phone story to the component's own
file. Cross-feature regression fixtures are named after the surface they cover
(`Navigation/AppHeader`, `Shared/HoverActions`).

Story IDs derive from titles and export names (`Workspace/ChatContent` +
`ComposerHeightChanges` → `workspace-chatcontent--composer-height-changes`).
Playwright specs in `e2e/` and some docs link to story IDs; search for the old
ID when you rename a title or story.

## States to cover

Cover each state a user can reach, not just the happy path:

- **Loading, empty and error.** Data-driven components need all three, plus a
  realistic populated state. Long names and overflow are worth a story when the
  layout can break.
- **Light and dark.** The toolbar switches theme and color-scheme preset. Pin a
  story to one with `globals: { theme: 'dark' }` or
  `globals: { colorScheme: '<preset id>' }` when the theme is the point of the
  story.
- **Phone.** Layout-heavy components need a phone story at about 390px:
  `globals: { viewport: { value: 'phone', isRotated: false } }`. The `phone`
  preset is defined in `.storybook/preview.ts`. Storybook 10 ignores
  `parameters.viewport.value`; use `globals`.
- **Interaction.** Menus, dialogs and forms should show their open or submitted
  state through a play function rather than a static screenshot.

## Mocking data

Stories never talk to a live backend. The global decorator in
`.storybook/preview.ts` wraps stories in a router, tooltip provider and tRPC
provider. A component that queries tRPC must get deterministic data from its
story; otherwise it stays in a loading state. Today stories either render a
presentational component with props, seed a local `QueryClient` with
`setQueryData`, or install a local `trpc.Provider` with a custom link that
answers by procedure path. Prefer the first; mocks should return fixed data and
must not depend on the current time unless the story pins it.

Use the app's providers rather than raw library equivalents (for example the app
`Toaster`, not `sonner` directly) so stories match production styling in both
themes.

## Play functions

Use `storybook/test` (`expect`, `within`, `userEvent`, `fn`, `waitFor`). Await
every assertion and interaction; the lint guardrails flag floating promises.
Query by role and accessible name, reset `fn()` mocks in `beforeEach`, and keep
play functions deterministic: no real timers longer than needed, no network.
