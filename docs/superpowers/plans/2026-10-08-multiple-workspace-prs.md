# Multiple workspace PRs — prerequisite storage and associations

The approved [main-session PR events plan](2026-10-08-main-session-pr-events.md)
replaces the former fixer design and owns monitoring, delivery, status,
migration, backup and integration. This document retains only its multiple-PR
prerequisites; it must not be used to build separate fixer sessions.

## Storage and identity

- Store one `WorkspacePR` per canonical workspace/URL association, with a stable
  ID, revision, attachment lifecycle and per-PR cache/observation.
- Move branch discovery scheduling to `WorkspacePRDiscovery`. Empty workspaces
  retain discovery state without a dummy PR row.
- Migrate known singleton URLs, cache fields and discovery scheduling without
  losing merged/closed associations. The historical collection migration may
  transfer legacy fixer bookkeeping, but the event cutover removes those tables
  before release.
- Declare sole resource writers and model ownership. Preserve explicit PR IDs
  through attachment, refresh, backup and import.

## Attach and discover

- Attach or reattach a canonical URL without replacing sibling associations. A
  failed initial fetch still retains the attachment with neutral facts.
- Scope cache writes and full observations to association identity and revision.
  A stale response cannot overwrite a detached, replaced or refreshed target.
- Discover all relevant branch PRs under a guarded discovery claim. Terminal
  state on one PR does not suppress another PR's refresh or queued event.
- Keep workspace branch identity independent of a PR's head-branch observation.

## Verification

```bash
pnpm test src/backend/multiple-workspace-prs.migration.test.ts \
  src/backend/orchestration/multiple-pr-attachment.integration.test.ts \
  src/backend/orchestration/pr-attachment.integration.test.ts \
  src/backend/services/workspace/resources/workspace-pr.accessor.test.ts
```

The replacement plan supplies event, recipient, retry, receipt, collection
projection and version-6 backup tests. Product release requires that complete
cutover; no intermediate fixer mode is supported.
