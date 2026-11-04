# Electron shell implementation plan

**Goal:** Finish #2938's native menu and window behavior without changing
backend or renderer ownership.

**Architecture:** A desktop-shell module owns the menu, validated window-state
file in Electron userData, and appearance-aware background. Lifecycle uses its
window options and attaches persistence before loading. Menu commands go through
the sandbox preload to the renderer shortcut registry; renderer actions stay in
the keyboard slice. Keep the platform title bar.

**Decisions:** Settings, New Workspace, Search and Toggle Sidebar use the
existing shortcut command IDs. Production keeps normal editing/window controls
but omits Reload and DevTools. Persist normal bounds and maximization at close,
validate JSON with Zod, clamp restored bounds to an available work area, and
recover from missing/corrupt state without blocking startup. Native background
follows system light/dark until the renderer syncs its resolved appearance.
Commands queue until the trusted renderer subscribes.

- [x] Add failing shell behavior, lifecycle options and sandbox preload tests.
- [x] Implement menu, state persistence/recovery and live system background.
- [x] Wire lifecycle and main; expose validated command subscription/cleanup.
- [ ] Run focused tests, Electron compiler, shared checks and full app suite.
- [ ] Update current desktop documentation, independent review, ready PR.
- [ ] Resolve CI/review feedback; merge only green with no outstanding comments.
