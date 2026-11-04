# Electron shell implementation plan

**Goal:** Finish #2938's native menu and window behavior without changing
backend or renderer ownership.

**Historical approach:** This work selected an isolated desktop-shell owner,
trusted queued menu dispatch through the sandbox preload, optional validated
window preferences, and renderer-to-native appearance sync. The platform title
bar was retained. The durable behavior is documented in
[Desktop backend process](../../architecture/agent-runtime.md#desktop-backend-process).

**Merge dependency:** The #2938 keyboard shortcut registry follow-up must land
before this native menu PR can merge. This native PR includes the renderer
`AppShortcuts` subscription to `electronAPI.onAppCommand`. Rebase on the landed
registry and verify current checks and zero unresolved review comments.

- [x] Add failing shell behavior, lifecycle options and sandbox preload tests.
- [x] Implement menu, state persistence/recovery and live system background.
- [x] Wire lifecycle and main; expose validated command subscription/cleanup.
- [x] Run focused tests, Electron compiler, shared checks and full app suite.
- [x] Update current desktop documentation, independent review, ready PR #2987.
- [ ] Integrate the landed registry, resolve CI/review feedback, and merge only
      green with no outstanding comments.
