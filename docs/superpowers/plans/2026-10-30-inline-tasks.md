# Inline tasks implementation plan

Show the current task list beneath the conversation for both Claude and Codex,
replacing the workspace Tasks tab. Use existing ACP plan state as the
authoritative list, including empty updates, with validated legacy TodoWrite
history as a fallback. Keep completed tasks visible and muted; show circular
status indicators and wrap long labels. Reuse existing React chat rendering and
scroll behavior without new dependencies. Include the current validated task
list in session snapshots so hydration clears stale client state while queue
updates preserve active tasks. Retain the latest validated plan in the session
store for replay and allow provider attach-time plan snapshots through history
suppression.

- [x] Add regression tests for ACP updates, empty lists, malformed legacy input,
      inline rendering during loading and idle states, and saved-tab migration.
- [x] Connect ACP state to the shared message list in workspace and quick chat;
      render a compact checklist and retain legacy history support.
- [x] Remove the Tasks tab and unused container; migrate saved selections to
      Changes and document the new behavior.
- [x] Update Storybook states, inspect them in a browser, run repository checks
      and tests, then review the final diff.
