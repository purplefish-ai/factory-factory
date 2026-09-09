# Client Features

Each feature owns its components, hooks, and helpers.

## Public API

Cross-feature imports use the feature's top-level `index.ts`; nested sub-barrels
stay private. Dependency-cruiser checks static and dynamic imports. Routes are
composition code and may import feature internals directly.

Add a barrel when another feature needs it, not before. Widen it only for an
intentional public capability, not to expose an internal helper to one caller.

## Shared code

When multiple features need the same code:

- Dependency-free utility → `src/client/lib/`.
- Shared component → `src/client/components/`. Preserve lazy split points;
  routing `terminal-instance.tsx` through a barrel would pull the feature into
  the lazy chunk.
- A cohesive group with multiple feature consumers and no knowledge of them
  → its own feature, as with `composer`.

`src/components/` is reserved for shadcn/ui. Follow the root guide's UI, testing,
and Storybook requirements.
