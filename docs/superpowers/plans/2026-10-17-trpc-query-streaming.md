# Stream completed tRPC queries independently

> **For agentic workers:** Use superpowers:executing-plans to implement and
> verify this focused PR.

**Goal:** A fast read in a shared HTTP batch reaches the client while a slow
read is still running.

**Architecture:** Route queries through tRPC 11's HTTP batch streaming link;
retain ordinary HTTP batching for mutations. Preserve relative URLs and
SuperJSON. Use the existing Express adapter without changing procedure
interfaces or response headers.

**Tech Stack:** TypeScript 7, React Query, tRPC 11, Express 5, Vitest 5.

**Spec:** User-approved dependency modernization proposal in this chat,
including a measured streaming trial. Prisma remains in place. The security
registry submission was declined.

## Constraints

- Keep API paths, input/output types, same-origin credentials and errors.
- Keep mutations on the existing non-streaming transport.
- No schema/database changes, new dependencies, or HTTP framework migration.
- Preserve architectural checks, coverage and existing assertions.

## Review focus

- Fast query settles before a deliberately gated slow query in one request.
- A failing query does not discard a successful sibling.
- SuperJSON dates and undefined fields survive streaming serialization.
- Mutations use ordinary JSON responses and preserve response cookies.
- The existing Express adapter and a pass-through proxy deliver incremental
  chunks; buffering proxies may still delay client-visible results.

## Task 1: Prove transport behavior and adopt query streaming

**Files:** Modify `src/client/lib/trpc.ts`; create
`src/client/lib/trpc.integration.test.ts`; document behavior in
`docs/architecture/integrations.md`.

- [x] Add real Express/tRPC transport fixtures using the production client. Test
      gated slow reads, independent errors, SuperJSON, mutations and same-origin
      fetch options. Verify the fast-read test fails with the existing batch
      link before editing production code.
- [x] Use `splitLink` with `op.type === 'query'`, `httpBatchStreamLink` for
      reads and `httpBatchLink` for other operations.
- [x] Run focused tests, then measure fast-result arrival against the previous
      link with identical delayed operations. Record local/proxy limitations.
- [x] Document query streaming and buffering caveats; update Unreleased notes.
- [x] Run `pnpm check:fix`, `pnpm typecheck`, relevant tests, `pnpm check`,
      production build and normal commit-hook checks; inspect final diff.
- [ ] Obtain independent review, fix findings, and open a ready PR using
      `gh pr create --body-file`. Attach the PR and report measurements.

## Verification

- Six transport cases pass through real Express HTTP and the authenticated
  proxy. The two gated fast-result regressions failed with ordinary batching.
- Formatting, typecheck, repository checks and production build pass. The local
  Codex schema check skips the installed CLI mismatch; CI uses its pinned CLI.
- Full suite: 6,564 passed, four skipped. An initial contended run hit an
  existing provider UI test's fixed 10 ms mount wait; its isolated 12 tests and
  the final unchanged full suite pass.
- Independent review found no actionable regression. Both links share upstream
  batch cancellation behavior; this change does not claim to cancel server work.
- Controlled trial: a 250 ms slow sibling, one warmup and five alternating
  measured rounds. Median fast-result arrival was 255.9 ms versus 5.0 ms both
  directly and through the proxy. These are synthetic transport measurements.
