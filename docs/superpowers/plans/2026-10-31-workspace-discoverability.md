# Workspace discoverability implementation plan

**Goal:** Give workspaces clear, stable names and branches, with short summaries
that track the work's current position in Kanban, the sidebar, and search.

**Status:** Historical implementation plan. This record describes the design
decisions below; it does not grant authorization for future work.

**Architecture:** A best-effort background orchestrator receives completed-turn
notifications. It calls a bounded, tool-free helper using the conversation's
provider/account, persists validated metadata through the workspace capsule, and
publishes it through the existing snapshot contract. Existing working sessions
and launch never wait for metadata inference.

## Committed design decisions

- Use Luna with low reasoning for Codex and Haiku for Claude; preserve the
  selected account. No new API keys or provider switching.
- Keep the first request, previous summary, and bounded recent human/assistant
  text. Exclude reasoning, tool output, attachments, and repository guidance.
- Generate a title only for explicitly marked prompt-generated workspace names.
  Compare-and-swap the name so manual edits win. Name only once.
- Store a branch suggestion once; consume it through the existing pre-push
  renamer. Preserve manually named, resumed, and already accepted branches.
- Coalesce completed turns per workspace; at most one call per two minutes.
  Reject results superseded by newer turns or transcript changes.
- Failures preserve previous metadata and retry with bounded backoff. Background
  work uses jobRunner, cancels on shutdown, and never blocks queue dispatch.
- Summary prose describes the work, not who said what. Do not invent completion.

## Tasks

1. Add shared validated metadata contracts, prompt construction, and focused
   tests for bounds, incremental input, and untrusted data.
2. Add persistence/migration and atomic metadata acceptance; cover manual edits,
   archival, repeat naming, and source provenance with integration tests.
3. Add disposable provider helpers and the throttled orchestrator; cover
   failure, coalescing, stale results, account routing, shutdown, and final
   pending updates.
4. Wire completion/lifecycle, snapshot projection, branch suggestions, search,
   and card/sidebar display. Update stories and architecture documentation.
5. Run formatting fixes, schema checks, typecheck, focused/full tests,
   integration tests, repository checks, and Storybook verification; review the
   final diff.

## Review focus

- Manual renames while inference is pending must win.
- New turns and multiple sessions must not publish older summaries.
- Missing credentials and provider failures must not affect the working agent.
- Large histories must remain bounded and omit tools/reasoning.
- Pending final updates must run after throttling even without another turn.
