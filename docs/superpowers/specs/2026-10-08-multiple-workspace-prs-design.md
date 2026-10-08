# Multiple workspace PRs — storage prerequisite

The [main-session PR events design](2026-10-08-main-session-pr-events-design.md)
supersedes the previous automation design. All monitored PRs feed the bound main
conversation's queue. There is no separate fixer ownership, provider selector or
per-PR fixer dispatch history.

Each attached PR has a stable workspace-owned association ID, canonical GitHub
URL, revision, attachment state and independent cached facts. Discovery cursors
belong to the workspace's `WorkspacePRDiscovery`, allowing branch discovery
before any PR exists. Attaching a second URL preserves the first association;
reattaching an existing URL preserves its identity. Explicit identity and
revision guard asynchronous fetches, detachment and writes.

Observations and events belong to their exact PR. A merged or closed sibling
cannot clear another PR's pending update or stop the main conversation.
Aggregate state reports MERGED only when all attached PRs are merged. Monitoring
enablement, recipient and pause remain workspace-scoped.

The singleton-to-collection migration preserves every known URL and its cached
state, including terminal PRs and discovery scheduling. Version-6 exports retain
all associations and their events; legacy versions remain accepted through the
replacement design's migration and backup contracts.

[Prerequisite implementation plan](../plans/2026-10-08-multiple-workspace-prs.md).
