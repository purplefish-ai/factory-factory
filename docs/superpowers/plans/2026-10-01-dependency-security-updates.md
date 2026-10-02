# Dependency and security update verification — 2026-10-01

## Scope and policy

Base: `932f59c687fe0d6c8048872df0f09919a33805a2`. Node 26.8.1 and pnpm 12.4.2
remain unchanged. The repository's `minimumReleaseAge: 0`, build allowlist, and
TypeScript aliases are preserved. The worktree uses an independent pnpm store,
installation, and native caches.

## Security inventory

GitHub's paginated Dependabot API returned **zero open alerts** and 205 fixed
alerts. The open-PR inventory contained no dependency update PRs. These are
GitHub default-branch observations, separate from the registry's audit of this
branch. GitHub may ingest the newly reviewed advisories later; branch fixes do
not close default-branch alerts until merged.

`pnpm audit --json` found **seven advisories before** (two high, four moderate,
one low) and **zero after**, covering development and production dependencies.
The final lockfile contains only the patched versions below on the affected
paths. No advisory was suppressed and no check was disabled.

| Package         | Before | Selected | Advisories                                                                                                                                                                                                          |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brace-expansion | 5.0.9  | 5.0.12   | [nested recursion](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [comma recursion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), [quadratic rewrite](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) |
| fast-uri        | 3.1.7  | 3.1.8    | [host normalization](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)                                                                                                                                             |
| ip-address      | 10.7.0 | 10.7.2   | [cross-family subnet](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [unbounded diagnostic](https://github.com/advisories/GHSA-h3mg-xc3c-68pw)                                                                 |
| dompurify       | 3.4.15 | 3.4.16   | [detached-subtree handlers](https://github.com/advisories/GHSA-p98j-92pf-mc4p)                                                                                                                                      |

## Compatibility decisions

- [Linear SDK 96](https://github.com/linear/linear/releases/tag/%40linear%2Fsdk%4096.0.0)
  removes an unused Jira input field;
  [97](https://github.com/linear/linear/releases/tag/%40linear%2Fsdk%4097.0.0)
  makes the package ESM-only. This project already uses ESM and Node 26; its
  real SDK transport fixtures cover authentication, lazy relations, date
  conversion, and authentication failure without contacting a live account.
- [dotenv 18](https://github.com/motdotla/dotenv/blob/v18.0.5/CHANGELOG.md)
  removes vault support and changes logging. The project uses neither vaults nor
  CommonJS preloading. Version 18.0.5 still exports `dotenv/config`, which is
  verified through Prisma generation and backend builds.
- [Claude ACP 0.78 → 0.85](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.78.0...v0.85.0)
  and
  [ACP SDK 1.4 → 1.6](https://github.com/agentclientprotocol/typescript-sdk/compare/v1.4.0...v1.6.0)
  include protocol additions and runtime fixes. Offline runtime/configuration
  tests pass. Live authenticated model tests remain skipped.
- React Resizable Panels 4.12.4 → 4.14.1 stays within the current major.
  Existing handle, persistence, and workspace state tests pass; no layout or
  persistence implementation is changed. The independent #2345 fix need not be
  stacked.
- Retain Mermaid 11.17.2.
  [Mermaid 12](https://github.com/mermaid-js/mermaid/releases) changes default
  layout, colors, and renderer configuration, and raises the Safari floor to
  17.4. Adopting its new presentation or explicitly preserving the old
  appearance needs a separate product/browser-support decision. Its DOMPurify
  advisory is fixed without that migration.
- Retain Prisma 7.10.0; the registry's `latest` tag points to 8.0.0-rc.19. No
  prerelease or unrelated forced-major transitive update is adopted.
- Align Electron Builder's Squirrel peer extension and override with 26.17.0.
  Refresh compatible existing transitive pins; retain security override scope.
- Biome 2.5.15 flags truthiness on an optional Promise. Use an explicit
  `!== undefined` presence test, preserving asynchronous dispatch semantics.
  Existing pending/failed prompt-completion tests pass.

## Direct versions

| Package                               | Before   | Selected |
| ------------------------------------- | -------- | -------- |
| @agentclientprotocol/claude-agent-acp | ^0.78.0  | ^0.85.0  |
| @agentclientprotocol/sdk              | 1.4.0    | 1.6.0    |
| @daypicker/react                      | ^10.0.1  | ^10.0.2  |
| @linear/sdk                           | ^95.1.0  | ^97.0.0  |
| @tanstack/react-query                 | ^5.103.1 | ^5.104.0 |
| @trpc/client                          | ^11.18.0 | ^11.19.0 |
| @trpc/react-query                     | ^11.18.0 | ^11.19.0 |
| @trpc/server                          | ^11.18.0 | ^11.19.0 |
| chalk                                 | ^6.0.0   | ^6.0.1   |
| dotenv                                | ^17.4.2  | ^18.0.5  |
| p-limit                               | ^7.3.2   | ^7.3.3   |
| react-resizable-panels                | ^4.12.4  | ^4.14.1  |
| ws                                    | ^8.21.3  | ^8.22.0  |
| @biomejs/biome                        | 2.5.14   | 2.5.15   |
| @storybook/addon-a11y                 | 10.6.0   | 10.6.1   |
| @storybook/addon-docs                 | 10.6.0   | 10.6.1   |
| @storybook/addon-themes               | 10.6.0   | 10.6.1   |
| @storybook/react                      | 10.6.0   | 10.6.1   |
| @storybook/react-vite                 | 10.6.0   | 10.6.1   |
| @types/node                           | ^26.6.1  | ^26.6.3  |
| @types/ws                             | ^8.18.1  | ^8.18.2  |
| @vitest/coverage-v8                   | ^5.0.1   | ^5.0.3   |
| dependency-cruiser                    | ^18.3.1  | ^18.5.0  |
| electron                              | ^44.4.1  | ^44.5.1  |
| electron-builder                      | ^26.16.1 | ^26.17.0 |
| jsdom                                 | ^30.0.1  | ^30.1.1  |
| knip                                  | ^6.36.0  | ^6.39.0  |
| lint-staged                           | ^17.5.1  | ^17.6.0  |
| prettier                              | 3.9.7    | 3.9.9    |
| storybook                             | 10.6.0   | 10.6.1   |
| supertest                             | ^7.2.2   | ^7.3.0   |
| tsc-alias                             | ^1.9.5   | ^1.9.7   |
| tsx                                   | ^4.23.13 | ^4.23.15 |
| vite                                  | ^8.3.0   | ^8.3.2   |
| vitest                                | ^5.0.1   | ^5.0.3   |
| wait-on                               | ^9.1.0   | ^9.5.1   |

## Validation

- Frozen baseline install; 5,732 tests passed, four skipped.
- Updated focused suite: 563 passed, four skipped; ratchet dispatch suite: 133
  passed.
- Full updated coverage suite: 5,732 passed, four skipped; statements 87.09%,
  branches 78.25%, functions 87.21%, lines 87.11%; global and critical coverage
  thresholds pass.
- Formatting, typecheck, strict guardrails with pinned Codex CLI 0.153.4,
  dependency boundaries, Knip, generated Prisma drift, import checks, and Biome
  ignore budget pass.
- Production and Storybook builds pass.
- Local security behavior probes pass for percent-encoded host normalization,
  cross-family subnet rejection, bounded IPv6 diagnostics, nested/comma brace
  parsing, and both DOMPurify after-sanitize removal hooks. These probes
  exercise installed transitive packages and do not alter application code.

- Electron 44.5.1 rebuild, unsigned macOS ARM64 directory package, and direct
  SQLite/Prisma SQLite/native PTY smoke tests pass, including from the packaged
  app. Windows and Linux packaging were not run locally.
- Final frozen install, production audit, full audit, and Node 26.8.1 SQLite/PTY
  smoke tests pass. Native cache switching alone left PTY's build directory
  without its spawn helper; the frozen reinstall restored the complete prebuild.
  The existing native cache helper stores only `pty.node`; this setup issue is
  reported separately rather than changing native tooling in this dependency PR.
- Prisma migration drift check passes.
- Real local ACP and bundled Claude CLI version-only startup pass (0.85.0 and
  Claude Code 2.1.286). Packaged ACP module startup passes. Its native CLI
  launch fails with `ENOTDIR` when resolving the executable inside `app.asar`;
  using the physical `app.asar.unpacked` path succeeds. ACP 0.78 and 0.85 have
  byte-identical `claudeCliPath()` resolvers, and this PR leaves packaging path
  handling unchanged. That inherited packaged-launch limitation needs a separate
  resolver/packaging fix; the package build and native SQLite/PTY smoke tests do
  not establish full desktop agent-session functionality.

Independent review found no issues in the scoped diff. Pull request CI and Cubic
review results are recorded with the submission; merging requires green checks
on the final head and no outstanding actionable review comments.
