# Pull requests

This note has moved. Read the
[pull request orchestration guide](../../src/backend/orchestration/pull-requests/AGENTS.md)
for ownership, public surface, invariants and the map, and the `2026-11-13-*`
records in [decisions](../decisions/) for the reasons. The tests the guide names
describe the behaviour.

<a id="pr-event-delivery-destinations"></a>Links here with this anchor were for
the derived `selectedPrId`/`selectedPr` contract: `deriveWorkspacePRSelection`
in `src/shared/workspace-pr.ts`, asserted by
`src/shared/workspace-pr-selection.test.ts` and
`src/client/lib/workspace-selected-pr.test.ts`.

This page remains as long as links from notes not yet migrated point here or the
section below still holds entries; delete it when both are gone.

## Held for other guides

Rules, hazards and reasons from the old note that belong to another area. Each
entry quotes only the sentences it needs from the paragraph named after it,
verbatim, with `[…]` where sentences between them are left out, and has not been
checked against the code. The migration that creates the named area's guide
checks the entry, moves what holds there and deletes the entry here. Paragraph
numbers are the rows of the disposition table in pull request #3213.

> Attachment, discovery and review-request filtering match associations
> case-insensitively on host, owner and repository, so a URL casing variant
> reuses the existing association instead of creating another. Duplicate
> associations stored before this matching are not merged.

Old paragraph 19. For the workspace capsule guide.

> Legacy flat aliases retain their existing mixed semantics at read/transport
> and export adapters: URL, number, review and sync timestamp describe the
> selected association; state, CI status, and merge conflicts describe the
> aggregate summary. Consumers must use `selectedPr` for association facts and
> `prSummary` for collection facts rather than pairing those legacy fields.

Old paragraph 28. For the workspace capsule guide.

> The event collector uses one per-lifetime projection worker for PR collection
> and monitoring invalidations. […] The worker owns retries and archive/stop
> fences, and has no GitHub, delivery, session, or Linear runtime dependency.

Old paragraph 29. For the workspace capsule guide. No dependency-cruiser rule
enforces the last clause.

> Successful ACP prompt turns reset the workspace's PR discovery backoff, as do
> runtime exits. ACP processes remain alive between turns, so waiting for
> process exit alone can leave a newly opened PR undiscovered after its checks
> fail.

Old paragraph 22. For the session capsule guide.

> Wrapped CLI failures keep the original error as `cause`. […] They never repeat
> the command line, so repository names cannot be classified as authentication
> or network failures and comment bodies stay out of errors.

Old paragraph 47. For the GitHub capsule guide.

> The snapshot service owns association lifecycle operations and reads the
> committed fields after observation; it has no alternate GitHub fetch or scalar
> snapshot writer.

Old paragraph 48. For the GitHub capsule guide.

> Branch discovery only matches the workspace branch, so PR detection also
> attaches the URL printed by an agent's `gh pr create` or GitHub MCP PR
> creation. […] Claude sends a command after announcing its tool call, so the
> command reaches interceptors when the call completes.

Old paragraph 21. For the interceptors guide (`src/backend/interceptors/`).

> Review sessions cannot gain permissions: a denied request can end the turn
> with no findings, so the prompt tells the reviewer never to ask and to report
> what it couldn't check.

Old paragraph 13. For the adversarial review guide or records.
