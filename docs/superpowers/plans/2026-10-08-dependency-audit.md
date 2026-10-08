# Dependency audit — 2026-10-08

## Inventory and release policy

The GitHub Dependabot API reported zero open alerts. The registry audit of the
starting lockfile reported eight advisories: one critical, four high, two
moderate, and one low. These are separate inventories; GitHub closes alerts on
the default branch only after fixes merge.

Update direct dependencies to stable published releases. Keep Prisma, its
client, and its SQLite adapter aligned at 7.10.0: the registry's latest Prisma
version is 8.0.0-rc.21, which is a prerelease. Keep the TypeScript 7 native
compiler and the TypeScript 6 compatibility API aliases used by build-time
consumers.

Mermaid 12 and the lint/format migration are separate changes. Workflow action
upgrades are also reviewed separately from application dependencies.

## Published security fixes

| Dependency                | Before  | Selected | Advisory                                                                                  |
| ------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------- |
| proxy-addr                | 2.0.7   | 2.0.8    | [IPv4-mapped trust subnet spoofing](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)    |
| @modelcontextprotocol/sdk | 1.29.0  | 1.32.1   | [OAuth authorization server selection](https://github.com/advisories/GHSA-6qxp-vccf-f47h) |
| source-map-js             | 1.2.1   | 1.2.2    | [Indexed source-map denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| http-cache-semantics      | 4.2.0   | 4.3.0    | [Cross-user cache disclosure](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)          |
| postcss-selector-parser   | 6.0.10  | 7.1.6    | [Selector parsing CPU exhaustion](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)      |
| katex                     | 0.16.47 | 0.18.2   | [Trust restriction bypass](https://github.com/advisories/GHSA-238p-pmpm-9mq7)             |

The workspace overrides cover every resolved affected path until upstream
dependencies accept the patched versions. Existing security overrides remain;
transitive major versions are not forced merely to match a latest tag because
their consumers may depend on the previous API.

## Advisories without published fixes

- [braces 3.0.3](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): recursive
  walkers can exhaust the stack on deeply nested patterns. It is a development
  dependency of `tsc-alias`, through globbing and watch dependencies. Neither
  braces nor sprintf-js has a published fixed version at the audit date. The
  local braces patch rejects more than 256 combined brace/parentheses containers
  and guards the compile, expand, and stringify walkers for caller-supplied
  ASTs. Regression tests resolve the package through its actual build consumer
  and cover ordinary expansion, boundary depth, and literal
  escaped/bracket/quoted delimiters. Version-based audits will continue to
  report this one advisory. No advisory is suppressed.

The targeted `@electron/get>global-agent: 4.1.3` override removes the old Roarr
logger and its vulnerable sprintf-js dependency. Electron's consumer still uses
the same `bootstrap()` API; the
[v4 release notes](https://github.com/gajus/global-agent/releases/tag/v4.0.0)
identify the breaking change as a switch from Flow to TypeScript. A local proxy
fixture checks the actual Electron download path without contacting an external
artifact host. Changing the exception class alone would leave unguarded callers
vulnerable, so no sprintf patch is shipped.

## Direct updates

| Package                               | Before  | Selected |
| ------------------------------------- | ------- | -------- |
| @electron/rebuild                     | 4.2.0   | 4.2.1    |
| @radix-ui/react-alert-dialog          | 1.1.23  | 1.1.24   |
| @radix-ui/react-checkbox              | 1.3.11  | 1.3.12   |
| @radix-ui/react-collapsible           | 1.1.20  | 1.1.21   |
| @radix-ui/react-context-menu          | 2.3.7   | 2.3.8    |
| @radix-ui/react-dropdown-menu         | 2.1.24  | 2.1.25   |
| @radix-ui/react-label                 | 2.1.15  | 2.1.16   |
| @radix-ui/react-progress              | 1.1.16  | 1.1.17   |
| @radix-ui/react-radio-group           | 1.4.7   | 1.4.8    |
| @radix-ui/react-select                | 2.3.7   | 2.3.8    |
| @radix-ui/react-separator             | 1.1.15  | 1.1.16   |
| @radix-ui/react-switch                | 1.3.7   | 1.3.8    |
| @radix-ui/react-tabs                  | 1.1.21  | 1.1.22   |
| @radix-ui/react-toggle                | 1.1.18  | 1.1.19   |
| @tanstack/react-query                 | 5.104.0 | 5.104.1  |
| @types/node                           | 26.6.3  | 26.6.4   |
| @vitejs/plugin-react                  | 6.1.1   | 6.1.2    |
| concurrently                          | 10.0.5  | 10.0.6   |
| dotenv                                | 18.0.5  | 18.0.6   |
| jsdom                                 | 30.1.1  | 30.1.2   |
| react-resizable-panels                | 4.14.1  | 4.14.3   |
| supertest                             | 7.3.0   | 7.3.1    |
| vite                                  | 8.3.2   | 8.3.4    |
| @agentclientprotocol/claude-agent-acp | 0.85.0  | 0.88.0   |
| @agentclientprotocol/sdk              | 1.6.0   | 1.7.0    |
| @linear/sdk                           | 97.0.0  | 97.1.0   |
| @playwright/test                      | 1.63.0  | 1.64.0   |
| @radix-ui/react-dialog                | 1.1.23  | 1.2.0    |
| @radix-ui/react-popover               | 1.1.23  | 1.2.0    |
| @radix-ui/react-scroll-area           | 1.2.18  | 1.3.0    |
| @radix-ui/react-slider                | 1.4.7   | 1.5.0    |
| @radix-ui/react-slot                  | 1.3.3   | 1.4.0    |
| @radix-ui/react-tooltip               | 1.2.16  | 1.3.0    |
| electron                              | 44.5.1  | 44.7.0   |
| knip                                  | 6.39.0  | 6.40.0   |

## Validation

- Unmodified baseline: 6,242 passed, four skipped.
- Updated full suite: 6,260 passed, four skipped, including 18 braces security
  and compatibility cases.
- `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check` pass.
- Production and Storybook builds pass.
- Electron 44.7.0 rebuild and direct SQLite, Prisma SQLite, and PTY runtime
  probes pass; the Node native cache is restored afterward.
- Actual Electron download through a local HTTP proxy passes; the old Roarr
  logger dependency is absent.
- Production audit: zero advisories. Full unsuppressed audit: one high braces
  advisory, mitigated by the local depth patch and covered by regressions.
- The local Codex schema check skips because the installed CLI is 0.160.1 and
  the repository expects 0.153.4. CI installs the pinned version and enforces
  the check. No schema baseline or pinned CLI is changed in this update.
- Live authenticated agent sessions and Windows/Linux packaging are not run
  locally.
