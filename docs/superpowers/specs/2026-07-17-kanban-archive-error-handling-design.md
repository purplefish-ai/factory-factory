# Kanban Archive Error Handling Design

## Goal

Show clear error feedback when Kanban archive mutations fail and prevent their promise rejections from escaping fire-and-forget card handlers.

## Root Cause

`KanbanProvider` exposes `archiveWorkspace` and `bulkArchiveColumn` as promises, but Kanban card and column callbacks intentionally consume them as `void` event handlers. Both helpers restore optimistic project-summary state when their mutation rejects and then rethrow. Because neither archive mutation has an `onError` callback, a card archive failure produces no toast and the rethrow can become an unhandled promise rejection.

The workspace detail hook already establishes the intended single-workspace error policy: `PRECONDITION_FAILED` uses the commit-specific explanation, while other failures use the server message with a fallback. The Kanban ratcheting helper also demonstrates the intended fire-and-forget boundary: mutation-level feedback owns the toast and the context helper catches without propagating.

## Considered Approaches

1. Add mutation-level `onError` handlers and swallow errors after optimistic rollback. Selected because it follows existing client patterns, keeps feedback next to mutation configuration, and aligns the async helpers with their fire-and-forget callers.
2. Show toasts directly in each helper's `catch` block. This would work, but duplicates error-copy policy between single and bulk paths and makes the mutation configuration inconsistent with the detail-page implementation.
3. Add a global tRPC or `unhandledrejection` handler. Rejected because it changes application-wide behavior and cannot provide the archive-specific precondition guidance required here.

## Design

Add the same archive error handler to `archiveMutation` and `bulkArchiveMutation`. For `PRECONDITION_FAILED`, show `Archiving blocked: enable commit before archiving to proceed.` For every other error, show the error message or `Failed to archive workspace` when it is empty.

Keep each helper's existing optimistic removal, rollback, refetch, invalidation, and `finally` cleanup behavior. Change only the catch boundary: restore the project-summary cache and then return normally instead of rethrowing. This makes both helpers safe whether a caller awaits them or invokes them as an event callback.

The bulk endpoint already converts individual workspace failures into result entries, so the client mutation rejects only for operation-level failures. The `onError` callback covers those failures; successful responses, including per-workspace result failures, retain existing refetch behavior.

## Edge Cases

- A single archive precondition failure gets the actionable commit message.
- A generic single archive failure surfaces the server message.
- An operation-level bulk archive failure surfaces the same archive error policy.
- After either failure, optimistic project-summary removal is rolled back and archiving IDs/issue links are cleared.
- The returned archive helper promise resolves after handled mutation failure, preventing unhandled rejections from `void` event callbacks.
- Successful archive and bulk archive refetch/invalidation behavior is unchanged.

## Testing

Add a jsdom regression test for `KanbanProvider` with tRPC boundary doubles. A probe component will capture the real context methods, rejected mutation doubles will invoke the configured `onError`, and assertions will verify the toast text, restored cache state, cleanup, and resolved helper promises for single and bulk archive failures. Run the new test before implementation to confirm it fails because no mutation error callbacks are registered and the helpers reject.

Then run the focused test, typecheck, formatter, full Vitest suite, and production build. This is a behavior-only error-state change, so there is no persistent visual state to capture in a screenshot.

## Scope

No backend, API, database, component layout, or styling changes are required.
