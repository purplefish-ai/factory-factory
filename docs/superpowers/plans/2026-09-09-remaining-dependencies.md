# Remaining Dependency Upgrades Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the remaining dependency upgrade queue in one PR, as requested after #2249 merged.

**Architecture:** Upgrade Linear SDK, SQLite driver/types, Chalk, Commander, and DayPicker together; adapt only demonstrated compatibility changes. Investigate Claude ACP's exact upstream agent-SDK pin independently and retain it unless evidence supports a safe change.

**Tech Stack:** Node 26.8.1, Electron 44.3.0, pnpm 12.3.4, TypeScript 7, Vitest 5.

**Spec:** User explicitly requests grouping all remaining upgrades into one PR; do not merge it.

## Constraints

- Preserve existing assertions, coverage thresholds, CLI behavior, database compatibility, and calendar selection/navigation.
- Keep native module switching functional for both Node and Electron, including Prisma's SQLite adapter.
- Keep the TypeScript compiler/API aliases and pinned Codex schema unchanged.
- No live Linear mutations or authenticated model prompts for validation.

## Task 1: Upgrade and migrate

**Files:** `package.json`, `pnpm-lock.yaml`, `src/components/ui/calendar.tsx`, calendar tests/stories, `CHANGELOG.md`; native-module tooling and affected integration files only where verification demonstrates incompatibility.

- [x] Fresh frozen install and baseline suite: 5,500 passed, 4 skipped.
- [x] Upgrade `@linear/sdk` to 94.0.0, `better-sqlite3` to 13.0.3, `@types/better-sqlite3` to 9.6.0, `chalk` to 6.0.0, `commander` to 15.0.0, and DayPicker to 10.0.1 using its preferred `@daypicker/react` package.
- [x] Run typecheck and focused tests to expose migration failures. Replace DayPicker's removed `table` class key with `month_grid` and verify selection/navigation and dropdowns through tests and a Storybook story.
- [x] Inspect better-sqlite3's N-API binary layout and Prisma's transitive v12 dependency; reproduce and fix any native-cache or packaging incompatibility with regression coverage.
- [x] Investigate Claude ACP 0.75.1's exact agent SDK 0.3.257 pin versus latest 0.3.266. Record upstream evidence and the decision.
- [x] Update the Unreleased changelog and relevant documentation.

## Task 2: Verify and submit

- [x] Run formatting, typecheck, full tests, strict guardrails/Codex schema, Knip, audit, and frozen install.
- [x] Build production and Storybook; exercise the calendar in a browser, CLI help/argument handling, Linear transport behavior with fixtures, and temporary-database migrations/Prisma operations.
- [x] Verify SQLite and PTY in Node and Electron, package an unsigned macOS ARM64 app, then restore Node native modules. Build the Linux/Alpine Docker builder for the changed native dependency.
- [x] Complete independent review and address findings.

Submission: commit through normal hooks and create one PR for the combined changes and wait for the user to merge it.

## References

- [better-sqlite3 13 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)
- [Chalk 6 release](https://github.com/chalk/chalk/releases/tag/v6.0.0)
- [Commander 15 release](https://github.com/tj/commander.js/releases/tag/v15.0.0)
- [DayPicker 10 migration](https://daypicker.dev/upgrading)

## Compatibility decisions

- Keep Prisma's supported better-sqlite3 v12 dependency alongside direct v13. v13
  ships N-API binaries; Prisma v12 and node-pty still require runtime-specific
  rebuilds. `pnpm rebuild:electron` now forces the shared cache helper to rebuild
  both the root dependencies and the adapter's resolved pnpm dependency location.
  Normal Node/Electron switches restore Prisma's resolved driver, never an
  arbitrary matching package in the store.
- Use the scoped `@agentclientprotocol/claude-agent-acp>@anthropic-ai/claude-agent-sdk`
  override to 0.3.266. Upstream ACP 0.75.1 still pins 0.3.257; the newer SDK brings
  permission fixes and adds merged-message attribution without a demonstrated
  incompatibility in the paths we use. Remove the override when upstream catches up.
- ACP offline validation against SDK 0.3.266: 556 tests passed, nine live integration
  cases skipped, two additional coalesced success/error fixtures with the latest
  scalar/array UUID stamps passed, and upstream typecheck/build/import checks passed.
  These fixtures validate compatibility, not actual model-generated frame ordering.
- Browser inspection exposed obsolete Tailwind variable sizing in the calendar;
  explicit `var(--cell-size)` utilities restore spacing for dates and navigation.
  The icon guardrail also needed a bounded named-import regex so a preceding
  DayPicker import cannot be mistaken for Phosphor icons.

Additional sources:
- [Claude SDK 0.3.265](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.265)
- [Claude SDK 0.3.266](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.266)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [ACP 0.75.1 turn handling](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.75.1/src/acp-agent.ts)

## Final validation

- Full suite: 5,507 passed, four skipped (455 passing files, one skipped).
- `pnpm check:fix`, typecheck, strict `pnpm check` with pinned Codex schema,
  Knip, frozen install, and audit passed; zero known vulnerabilities.
- Production and Storybook builds passed. Calendar selection, disabled dates,
  next-month navigation, month/year dropdowns, and screenshots checked in Chromium.
- Real Linear SDK fetch fixtures cover authentication, lazy issue relations,
  date normalization, and authentication failure without account access.
- Node 26.8.1 and Electron 44.3.0 passed temporary migrations and backend database
  health. Node → Electron → Node cache restoration passed; Node binaries restored.
- Unsigned macOS ARM64 package started successfully with working preload/clipboard
  and native PTY. Packaged direct SQLite 13.0.3 and Prisma's 12.11.1 both queried
  successfully. Linux ARM64 Alpine builder and CLI migrations passed.
- Independent review identified arbitrary SQLite cache discovery and Windows
  command-shim handling; both fixed with focused regression coverage. Windows
  desktop packaging was not run locally.
