# Client Features

One folder per feature, holding its components, hooks and helpers together.
Current features: `chat`, `composer`, `data-import`, `kanban`, `project`,
`subagents`, `voice`, `workspace`.

## The barrel rule

A feature that another feature consumes exposes an `index.ts` as its **sole**
public API, and the import must go through it — the same discipline the backend
service capsules follow. Enforced by the
`cross-feature-imports-go-through-the-barrel` dependency-cruiser rule, which
catches dynamic `import()` as well as static.

Only a feature's own top-level `index.ts` is public. A nested sub-barrel such as
`chat/agent-activity/index.ts` stays private.

`data-import` and `project` have no barrel because no other feature imports
them. Add one when that changes, not before.

The rule constrains feature→feature edges only. `src/client/routes/` is the
composition layer and still reaches in directly.

## Where shared client code goes

When two features need the same module, widening a barrel is usually the wrong
fix — it makes an internal file another feature's public API for the sake of one
caller. Move it instead:

- **A dependency-free utility** → `src/client/lib/` (e.g. `rolling-output.ts`).
- **A shared component** → `src/client/components/` (e.g.
  `terminal-instance.tsx`, deliberately kept a direct import by both callers
  because it is a `React.lazy` split point and routing it through a barrel would
  pull the whole feature into the lazy chunk).
- **A coherent group of modules** with two feature consumers and no knowledge of
  either → its own feature (that is how `composer` came to exist).

Widening a barrel is right only when the export is genuinely part of what the
feature *is* — for example `chat` re-exporting `GroupedMessageItemRenderer` for
`workspace`'s closed-session transcript.

## Boundaries

- `src/components/` is the shadcn/ui design system and nothing else; the path is
  pinned by `components.json`. Feature UI never goes there.
  (`components-dir-is-design-system-only`)
- The client imports backend code only through the tRPC type surface.
- No native `alert`/`confirm`/`prompt` — use `ConfirmDialog` / `AlertDialog`
  from `@/components/ui`.
- No `'use client'` / `'use server'` directives.

## Conventions

- Add or update `*.stories.tsx` when you change UI; check them with
  `pnpm storybook`.
- Tests are co-located and run under Vitest.
