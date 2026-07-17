# Admin IDE Test Current Command Design

## Goal

Make the Admin IDE settings Test button execute the command currently displayed in the custom-command input, including edits that have not finished saving.

## Root Cause

The custom-command input is controlled by `localCustomCommand` and persists on blur, but the Test handler and disabled state read `settings.customIdeCommand`. The query value remains stale while the blur-triggered update is in flight, so the UI can disable Test for a valid draft or execute a previously saved command.

## Design

Use `localCustomCommand` as the single source of truth for both Test eligibility and the `testCustomCommand` mutation argument. Keep on-blur persistence unchanged. The backend already validates and executes the mutation argument, so it needs no changes.

This is preferable to awaiting the save mutation because testing a draft does not require persistence and coupling the two mutations would add latency and failure modes. It is also preferable to optimistic query-cache updates because local state already contains the exact user-visible value.

## Testing

Add a focused jsdom regression test in `src/client/routes/admin-page.test.tsx`. Configure the mocked settings for a custom IDE with no saved command, type a valid command into the input, verify Test becomes enabled, click it, and assert `testCustomCommand` receives the draft value. This single scenario covers both reported regressions while preserving backend validation for malformed commands.

## Scope

Only `src/client/routes/admin-page.tsx`, its co-located test, and workflow documentation change. Whitespace handling, persistence-on-blur, server validation, and success/error toasts remain unchanged.
