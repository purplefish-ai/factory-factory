# Changelog

All notable changes to Factory Factory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.9] - 2026-02-24

### Added

- Add first-class web search tool display in session tool cards (#1237)
- Add ACP context compaction indicator state wiring (#1246)
- Add app/core enum drift guard to keep shared enum contracts synchronized (#1256, #1259)
- Add workspace-detail navigation affordances with Reviews workspace and back-link actions (#1262, #1268, #1269)
- Add stop hook to pre-push branch rename interceptor for safer interrupt handling (#1273)

### Changed

- Improve terminal/logs hierarchy and setup status UX (#1236)
- Centralize environment variable validation through `ConfigEnvSchema` for consistent startup checks (#1247)
- Centralize workspace archiving with persisted `ARCHIVING` state and hide archiving rows in snapshot streams (#1250, #1280)
- Unify snapshot projection semantics (`stateComputedAt`) and workspace derived-state assembly to reduce backend/UI drift (#1253, #1257, #1260)
- Unify CI status classification and run-script config persistence behavior (#1258, #1261)
- Organize settings into tabs and reuse Kanban workspace creation UI in the sidebar flow (#1266, #1272)
- Downgrade ratchet workspace check failures to warnings and route reconciliation initialization through the ratchet bridge (#1270, #1277)
- Make ACP context compaction translation type-safe and propagate `stopAllClients` timeout through runtime manager boundaries (#1276, #1278)
- Expand single-writer checker coverage for workspace mutators (#1267)

### Fixed

- Fix chat auto-scroll behavior during rapid tool-call expansion (#1248)
- Clear pending request state and prompt-turn timers when sessions stop (#1243, #1245)
- Fix sidebar/layout regressions across workspace flows: board sidebar reset on navigation, side-panel resize handle hit target, draggable app sidebar resizing, new-workspace card button wrapping, and sidebar workspace form overflow (#1279, #1281, #1282, #1284, #1285)
- Fix inconsistent auto-fix label naming in sidebar workspace form (#1279)

### Refactored

- Extract workspace flow types into shared modules (#1238)
- Refactor interceptor timer lifecycle handling (#1239)
- Refactor `SessionService` ACP event processing into dedicated modules (#1240)
- Refactor Codex app-server ACP adapter into focused parser/retry/negotiation modules (#1241, #1283)
- Extract workspace initialization startup script pipeline (#1242)
- Refactor ratchet service into focused helper modules (#1249)
- Rename session history loader service file for clearer ownership (#1274)

### Removed

- Remove dead `FEATURE_*` flags from config and admin diagnostics (#1244)
- Remove `BACKEND_PORT` marker from normal startup logs (#1271)

### Documentation

- Remove stale Linear sync deliverable comment (#1275)

## [0.3.8] - 2026-02-24

### Added

- Add `postRun` script support to `factory-factory.json` for post-session automation hooks (#1206)
- Add startup mode selection when creating Kanban workspaces (#1218)
- Add Kanban new-task attachment support in workspace creation flows (#1211)
- Add `@` file mention autocomplete in Kanban workspace creation (#1202)
- Add build tools to Docker runner stage for native module compilation (#1201)
- Add `CLOUD_MODE` flag for Docker tunnel control (#1199)

### Changed

- Unify workspace state projection and remove UI polling for more immediate status updates (#1228)
- Improve Kanban navigation and workspace creation flow, including direct project-name navigation and sidebar creation entrypoints (#1223, #1208)
- Update workspace and board UX with refined headers, controls, and mobile PR context chips (#1196, #1197, #1200, #1219, #1220)
- Group terminal logs under a single Logs tab and streamline sidebar tab/grouping behavior (#1230, #1231, #1232)
- Separate settings into General and Project sections for clearer configuration boundaries (#1215)
- Increase pasted text attachment threshold for larger input support (#1226)
- Consolidate `src/frontend` into `src/client` to simplify client structure and ownership (#1207)
- Revert workspace scripts to `pnpm install/dev` defaults (#1205)
- Switch local Docker development to `docker-compose` with file watching (#1203)
- Skip archive warnings for done or merged workspaces to reduce unnecessary prompts (#1214)

### Fixed

- Fix archived workspaces lingering in sidebar and project summary views by tightening archive filtering and visibility updates (#1221, #1227)
- Fix Workspaces sidebar navigation button highlighting on detail routes (#1222)
- Fix duplicate workspace entries appearing in the sidebar (#1216)
- Fix Docker-in-Docker daemon crash by adding `containerd` and vfs driver configuration (#1204)
- Harden JSON fallback parsing with schema validation and remove unsafe runtime coercions in snapshot paths (#1234, #1233)

### Refactored

- Refactor Codex ACP adapter into parser, stream, and protocol modules (#1225)
- Extract session configuration and permission services and split associated tests for better module isolation (#1224)
- Route conversation rename behavior through the session domain barrel API (#1217)
- Inject session runtime singletons through `AppContext` to centralize runtime wiring (#1213)
- Refactor run script service dependency-injection wiring (#1235)
- Remove deprecated or legacy compatibility paths (`KanbanIssue` alias, sidecar init fallback, eager CORS app context initialization) (#1209, #1210, #1212)

## [0.3.7] - 2026-02-20

### Added

- Add pre-PR branch rename interceptor (#1097)
- Add archive controls and bulk archive actions in Kanban and workspace views (#1101, #1107, #1138, #1159)
- Add New Workspace actions in workspace detail and Kanban Issues column (#1106, #1111)
- Add Docker build-and-push workflow for GHCR branch testing (#1108)
- Add PR re-review tagging comment after ratchet fixes (#1116)
- Add inline workspace creation form on Kanban board (#1123)
- Add terminal QR code and proxy script for private tunnel direct links (#1146, #1155)
- Add empty-state messaging for no active workspaces in side panel (#1137, #1152)
- Add default permission presets for ratchet and workspace sessions (#1160)
- Surface session startup failures across workspace surfaces (#1167)
- Add GitHub URL clone flow for project creation (#1169)
- Add CLI auth readiness checks to onboarding (#1185)
- Install GitHub CLI, Claude CLI, and Codex CLI in Docker image (#1172, #1177)

### Changed

- Refresh app UI/UX and iterate on Kanban and workspace information density (#1099, #1110, #1125, #1131, #1133, #1136, #1143, #1144, #1150, #1157, #1165, #1173, #1182, #1188)
- Rewrite Dockerfile/docker-compose for cloud deployment and proxy workflows (#1098, #1124, #1156)
- Rename auto-generated branches before push and PR (#1176)
- Improve workspace and sidebar navigation patterns across desktop/mobile (#1102, #1105, #1113, #1115, #1171, #1174, #1178, #1181, #1192)
- Improve mobile layout behavior and menu/header ergonomics (#1118, #1147, #1148, #1149)
- Improve chat follow-mode near-bottom scrolling behavior (#1121, #1122)
- Make Kanban transitions and archive interactions feel immediate (#1154, #1170, #1187)
- Improve ratchet reliability by gating dispatch on actionable PR signals and persisting toggle state snapshots (#1145, #1184, #1189)
- Move workspace quick actions into the session bar and auto-save IDE settings on change (#1183, #1194)
- Enforce provider CLI readiness checks and update ratchet Codex startup defaults (#1117, #1162)

### Fixed

- Fix active navigation highlighting and board labeling inconsistencies (#1104, #1128)
- Fix mobile chat reconnect getting stuck on "Connecting" (#1112)
- Fix circular JSON crash in NewWorkspaceButton onClick (#1127, #1129)
- Fix Docker runtime crashes from Prisma 7 `.ts` imports in compiled output (#1119, #1151)
- Fix Docker publish workflow trigger on pushes to `main` (#1135)
- Fix null `submittedAt` handling in PR review details (#1141)
- Fix Kanban archive cancel navigation and done-column UX (#1142)
- Fix admin refresh button overflow on mobile (#1153)
- Fix Launch button overlap in New Workspace form (#1179, #1180)
- Fix terminal-instance mixed-import chunk warning (#1186)
- Fix CLI health banner layout and light-mode colors (#1175, #1191)

### Security

- Bump dependency security overrides and refresh lockfile (#1193)

### Testing

- Increase backend coverage and tighten critical coverage gates (#1114, #1166)

## [0.3.6] - 2026-02-19

### Added

- Add Linear domain, crypto service, and schema migration (#1067)
- Add Linear admin configuration UI (Deliverable 2) (#1069)
- Add Linear issues to Kanban board (Deliverable 3) (#1072)
- Persist chat input attachments across navigation/refresh (#1073)
- Persist workspace tool-call expansion across navigation (#1074)
- Add Linear issue prompt, state sync, header link, and export schema (D4-D6) (#1079)
- Add ff proxy command with private cloudflared auth mode (#1088)

### Changed

- Improve sidebar pending-request UI and stories (#1062)
- Normalize new-session control height in tab bar (#1063)
- Temporarily hide issue tracking UI from admin panel (#1070)
- Render Codex fileChange calls as first-class cards (#1075)
- Upgrade dependencies to latest versions (#1076)
- Improve mobile layout reliability and add Playwright baseline tests (#1077)
- Speed up pending and ratchet UI feedback (#1080)
- Simplify sidebar footer and add workspace branch GitHub link (#1081)
- Simplify mobile workspace header actions (#1085)
- Enable quick actions while agent is running (#1093)

### Fixed

- Skip Codex reasoning blocks in history hydration (#1064)
- Fix interleaved FK PRAGMAs in migration runner (#1071)
- Fix queued messages stuck after stopping and restarting agent (#1083)
- Fix mobile keyboard causing full-page scroll in chat (#1084)
- Fix mobile overflow in prompts and startup forms (#1086)
- Avoid redundant chat auto-scroll writes (#1087)
- Fix knip entrypoints for CLI and backend (#1089)
- Fix stuck pending tool calls after command handoff (#1090)
- Fix mobile chat layout when keyboard opens (#1091)
- Patch Dependabot transitive vulnerabilities (#1092)
- Redirect away from archived workspace detail (#1094)
- Fix false not-pushed indicators in workspace changes (#1095)

### Documentation

- Add Linear Integration Design Doc (#1065)
- Improve Linear integration design doc (#1066)

## [0.3.5] - 2026-02-16

### Added

- Implement Codex ACP semantic follow-ups (#1044)
- Add provider CLI warning for missing installation or authentication (#1049)

### Changed

- Move agent activity into main chat and remove live activity dock (#1046)
- Simplify running status to latest reasoning (#1050)
- Unify side-panel changes and add status dots (#1052)
- Group new-session controls and clarify provider affordance (#1053)
- Render stripped plaintext in live reasoning indicator (#1054)
- Improve Storybook coverage for key app views (#1051)
- Poll for review comments every 2 minutes and include them in fixer prompt (#1059)

### Fixed

- Fix ExitPlanMode plan visibility and mode selection (#1041)
- Align Codex ACP tool IDs and approval semantics (#1043)
- Fix quick action prompt not auto-sending after session creation (#1045)
- Fix disappearing chat messages after refresh (#1047)
- Fix Codex PR interception for created pull requests (#1048)
- Retry queued dispatch after session stop (#1055)
- Fix chat auto-scroll when large messages expand (#1057)

### Refactored

- Refactor diff parsing to reduce cognitive complexity (#568, #999)
- Extract file processing logic to reduce cognitive complexity (#998)

## [0.3.4] - 2026-02-16

### Added

- Add Codex app-server ACP adapter (#1030)
- Add pending user-input state visibility across workspace views (#1022)
- Add queued message auto-dispatch after prompt completion (#1029)

### Changed

- Simplify live activity dock and summarize agent progress (#1026)
- Simplify workspace right-panel tabs (#1021)
- Enforce non-interactive mode for ratchet and issue dispatch (#1025)

### Fixed

- Fix Codex execution mode options when requirements are missing (#1039)
- Handle Codex `commandExecution` payloads in PR detector flow (#1038)
- Fix missing transcript entry for dequeued queued messages (#1037)
- Propagate idle transition and queue-clear snapshots on session stop (#1034, #1035)
- Avoid chat auto-scroll during hydration (#1036)
- Fix false frontend force-kill log on shutdown (#1033)
- Fix false orphan agent sessions in admin process list (#1031)
- Fix `/logs` hanging on large log files (#1027)
- Hide workspace immediately during archive to avoid stale visibility (#1028)

### Refactored

- Refactor duplicate code paths across UI and session loaders (#1023)
- Remove deprecated auto-fix monitor/fixer stack and unused workspace ratchet fields (#1019, #1020)

## [0.3.3] - 2026-02-14

### Fixed

- Fix `npx factory-factory@latest serve` failing during npm package linking (`Cannot destructure property 'package' of 'node.target' as it is null`) by removing the published `file:packages/core` dependency and in-package core import path

### CI

- Align npm publish workflow smoke test to use packed-tarball `npm exec --package ...` so npx/npm exec install-link failures are caught before release

## [0.3.2] - 2026-02-14

### Fixed

- Fix `npx factory-factory@latest serve` crashing at startup with Prisma runtime `Cannot read properties of undefined (reading 'graph')` by pinning `@prisma/adapter-better-sqlite3`, `@prisma/client`, and `prisma` to 7.3.0 and enforcing supported Node engines in package metadata
- Update installation prerequisites to match Prisma-supported Node versions

## [0.3.1] - 2026-02-14

### Fixed

- Fix npm/npx installation failure by replacing `workspace:*` dependency resolution for `@factory-factory/core` with publish-safe packaging

## [0.3.0] - 2026-02-14

### Added

- Add Codex model-list and reasoning schema hardening (#986)
- Add Playwright MCP screenshots with quick action and viewer UI (#981)
- Add provider-aware AgentSession migration support (#964, #975)
- Add Codex app-server adapter and manager (#962, #971)
- Add @ file mention autocomplete in chat input (#955)
- Add integration coverage for websocket and accessor paths (#958)
- Add syntax highlighting to diff viewer (#974)

### Changed

- ACP cutover: migrate runtime/protocol from custom parsers (#1000)
- Support workspace initialization from blank repositories (#988)
- Make chat bar capability-driven by provider (#982, #983)
- Move provider select beside new session button (#995)
- Keep provider preselect enabled while running (#980)
- Provider-neutralize session adapter seam follow-up (#968, #969)
- Refactor Claude sessions behind runtime adapter seam (#963, #967)
- Configure dev server setup flow for clarity (#972)
- Unify ClaudeActiveProcessSummary type source (#970)
- Auto-build @factory-factory/core in all npm scripts (#987)
- Extract shared session hydrate key builder (#993)

### Fixed

- Fix symlink escape in isPathSafe (#917) (#1010)
- Fix duplicate history replay after hydration (#1009)
- Fix non-shell -c command previews (#1008)
- Fix Run tool rendering in activity view (#1007)
- Harden Claude history loader and bound retry cache (#1006)
- Load session history without passive runtime startup (#1004)
- Fix duplicate transcript injection from ACP user_message_chunk (#1003)
- Fix session load/runtime UX and Codex chat-bar hydration (#1002)
- Show concrete workspace default provider labels (#1001)
- Refine provider UX and sync Codex capabilities (#994)
- Hydrate Codex sessions from thread/read (#992)
- Harden Codex session boundaries and clarify unsupported tool calls (#991)
- Replace raw runtime casts with Zod validation (#990)
- Remove duplicated workspace session model defaults (#985)
- Refactor ratchet session stop handling (#978)
- Reset ratchet dispatch tracking when fixer session dies without doing work (#976)
- Clear persisted Codex thread mappings on session clear (#973)
- Fix workspace not updating after PR creation detected (#954)
- Add exponential backoff polling for late-arriving PR review comments (#945)

### Refactored

- Remove compatibility barrels and shim aliases (#989)
- Phase 3 contract cutover: provider-neutral API/events (#965, #979)
- Enforce stricter backend dependency boundaries (#959)
- Implement core library extraction scaffolding and enum extraction (#957)
- Archive v1.1 Project Snapshot Service milestone (#961)

### Documentation

- Add Factory Factory Cloud vision and V1 MVP plan (#956)
- Add Factory Factory Cloud vision document (#892)

## [0.2.8] - 2026-02-11

### Added

- Add v1.1 Project Snapshot Service for improved workspace state management (#944)
- Add Factory Factory signature to agent-created PRs (#938)
- Always show session tab bar with + button for easier session management (#948)

### Fixed

- Fix snapshot_removed not clearing workspace.get cache (#952)
- Fix #912: Catch unhandled sendRaw rejection in sendInitialize and sendRewindFiles (#946)
- Fix CI status computation to handle NEUTRAL conclusion (#947)
- Fix #935: Prevent workspace from tagging old merged PRs (#939)
- Fix #914: LoggerService crash on circular references (#925)
- Fix logger service to expand environment variables in BASE_DIR (#934)
- Fix workspace tab status drift and stuck loading state (#931)

### Changed

- Unify workspace status with snapshot single writer (#949)
- Dedupe workspace, chat, and fixer flows across stack (#941)
- Unify workspace init script messaging (#906)
- Refresh README with npx instructions and comprehensive updates (#933)

### Refactored

- Enforce single-writer ownership and fix test ABI setup (#951)
- Enforce safer promise handling with Biome rules (#950)
- Enforce @ imports and remove compatibility barrels (#942)
- Refactor websocket handlers and queue policies (#940)
- Remove unused REST and MCP routing surfaces (#943)
- Remove redundant init script banner, keep inline chat message (#932)

## [0.2.7] - 2026-02-10

### Added

- Add app running play indicator to sidebar and Kanban cards (#763)
- Add searchable server logs page with filtering and download (#848)
- Add expandable rows with formatted JSON to logs page (#858)
- Add session management UI with increased p-limit concurrency to 20 (#856)
- Add re-review request step to ratchet dispatch prompt (#876)

### Changed

- Change default theme from system to dark (#864)
- Improve workspace init UX with chat-first queueing (#878)
- Start Claude session eagerly during workspace init (#874)
- Show factory config for all projects in admin panel (#882)
- Open Dev Logs panel when starting workspace run script (#884)
- Replace init banner with inline spinner (#886)
- Make kanban board and list view mobile responsive (#901)
- Add mobile-responsive layout with hamburger menu sidebar (#896)

### Fixed

- Fix ratchet to check for any working session, not just non-ratchet ones (#838)
- Fix session process manager race condition (#865)
- Fix sessions stuck in loading state (#867)
- Fix cross-process race condition in resume mode file lock (#866)
- Fix PR comment updatedAt validation error (#871)
- Fix dev server child processes not killed on shutdown (#875)
- Fix session loading stuck on cold start (#872)
- Fix workspace reorder triggering page refresh (#885)
- Fix non-selected session tab status icons (#891)
- Fix intra-domain import: use worktreeLifecycleService.setInitMode directly (#889)
- Fix run script STOPPING leak on process exit (#897)
- Fix queued messages disappearing when switching workspaces (#868)
- Fix queued messages disappearing on page refresh (#855)
- Fix GitHub CLI bot comment validation error (#857)
- Fix infinite loading when session loads from history (#861)
- Fix session stuck in loading phase after creation (#863)
- Fix centered terminal text alignment (#859)
- Show actual error message when Mermaid diagram fails to render (#851)
- Fix resume modes file write race condition with atomic rename (#853)

### Refactored

- Enforce architecture boundaries and isolate DB access (#840)
- Enforce layer boundaries: tRPC/routers must use services, not accessors (#839)
- Add session domain single-writer boundary (#842)
- Refactor Claude session runtime lifecycle ownership (#843)
- Centralize backend runtime constants and lock safety warnings (#845)
- Tighten TS typing and ban z.any usage (#847)
- Refactor session store into focused modules (#849)
- Remove inline Biome ignores and enforce zero policy (#850)
- Refactor PR detail panel to reduce cognitive complexity (#571) (#862)
- Extract file lock mutex and atomic write utilities (#873)
- SRP refactor: Phase 1 — Foundation & Domain Scaffolding (#879)
- SRP refactor: Phase 2 — Session Domain Consolidation (#883)
- SRP refactor: Phase 3 — Workspace Domain Consolidation (#887)
- SRP refactor: Phase 4 — GitHub Domain Consolidation (#890)
- SRP refactor: Phase 5 — Ratchet Domain Consolidation (#894)
- SRP refactor: Phase 6 — Terminal Domain Consolidation (#893)
- SRP refactor: Phase 7 — Run Script Domain Consolidation (#895)
- SRP refactor: Phase 8 — Orchestration Layer (#898)
- SRP refactor: Phase 9 — AppContext & Import Rewiring (#899)
- SRP refactor: Phase 10 — Validation & Stabilization (#900)
- Improve test coverage for domain services with edge case tests (#902)

### Documentation

- Write server logs to file instead of terminal (#844)
- Ratchet should @ mention reviewers when responding to comments (#881)
- Clean up ratchet sessions when work is finished (#877)
- Skip merged and disabled workspaces in ratchet poll loop (#852)
- Enable parallel workspace archiving by removing global isPending check (#870)
- Enable parallel workspace archiving and skip confirmation for merged PRs (#854)
- Reduce GitHub API polling and add rate limit backoff (#860)
- Archive v1.0 SRP Consolidation milestone (#904)

## [0.2.6] - 2026-02-08

### Fixed

- Fix #824: Skip branch rename for additional Claude sessions (#832)
- Fix tool call message rendering (#834)
- Fix session hydration and live message parity (#818)
- Fix tool preview height clipping in live activity box (#817)
- Fix #810: Adjust tool preview height in resizable live activity box (#813)
- Fix #802: Indicate factory-factory.json detection during project import (#814)

### Changed

- Harden transcript hydration, lineage guards, and streaming consistency (#836)
- Show workspace initialization status immediately after creation (#833)
- Unify chat state with a single SessionStoreService (#827)
- Simplify and clarify ratcheting UI and documentation (#821)
- Disable partial assistant message streaming (#829)

### Refactored

- Remove legacy message state bypass APIs and protocol artifacts (#830)
- Skip pre-commit hooks when archiving workspaces (#828)
- Fix ratchet to only dispatch when CI is in terminal state (#823)
- Treat idle non-ratchet sessions as idle for ratchet (#816)
- Refactor ratchet decision flow and diagnostics (#811)

### Added

- Add visual indicators for pending plan approval and user questions (#771) (#815)

## [0.2.5] - 2026-02-07

### Added

- Centralize sidebar status and add CI chip (#799)
- Enable concurrent multi-workspace archiving (#787)
- Enhance GitHub issue prompt with orchestrated workflow (#783)

### Changed

- Unify session runtime status model and transport (#807)
- Unify CI status icons across workspace views (#806)
- Simplify ratchet to a single idle-gated dispatch loop (#798)
- Batch session hydration to eliminate tab-switch replay flicker (#797)
- Move live activity drag handle from bottom to top (#796)
- Improve archiving workspace overlay with multi-ring animation (#791)
- Enable noImplicitOverride TypeScript compiler option (#795)
- Increase Vite chunk size warning limit to 5MB
- Update homepage URL to https://factoryfactory.ai

### Fixed

- Fix sidebar width localStorage persistence (#808)
- Fix #800: Unify the Markdown loading logic (#804)
- Fix #727: Introduce guarded run-script runtime state machine (#792)
- Fix #750: Add lint guardrails for unsafe JSON.parse casts and unknown resolver casts (#794)
- Fix #747: Validate persisted JSON stores with Zod schemas (#793)
- Fix #748: Use shared schema for frontend backup import parsing (#789)
- Fix #746: Schema-validate GitHub CLI JSON responses (#788)
- Fix task list clipping and blank state during TodoWrite (#784, #786)
- Fix queued message ordering to use dispatch time instead of queue time (#782)

### Refactored

- Validate Claude stream JSON and session JSONL inputs at parse boundaries (#745, #790)
- Refactor chat handler registry to eliminate message payload casts (#785)

## [0.2.4] - 2026-02-06

### Added

- Show GitHub issue details in side panel (#777)

### Changed

- Improve session status indicators during workspace startup (#774)
- Format statuses in status dropdown (#776)
- Lighten secondary text color in dark mode (#769)
- Unify session start semantics across WebSocket and tRPC (#773)

### Fixed

- Fix workspace WAITING flicker during GitHub issue dispatch (#772)
- Clear workspace notification glow on selection (#775)
- Harden Claude protocol control responses with schema validation (#755)

### Refactored

- Refactor attachment validation to reduce complexity (#778)
- Enforce PRSnapshotService as single writer for workspace PR fields (#770)
- Phase 4: Backup/Import v2 and Compatibility Hardening (#722)

### Documentation

- Ratchet reliability: design doc + stale CI guard + agent branch sync (#762)

## [0.2.3] - 2026-02-06

### Added

- Add draggable height resize to live activity feed (#757)
- Show starting state for issue workspace auto-start (#758)

### Changed

- Stabilize live activity dock with internal tool scrolling (#754)
- Clear ratchetActiveSessionId on session exit (#760)

### Fixed

- Fix chat replay flicker by showing loading state during reconnect (#756)
- Fix agent messages lost when Claude process is replaced (#752)
- Fix kanban column scrolling when items overflow (#753)
- Fix crash when argumentHint is non-string in slash command cache (#743)

## [0.2.2] - 2026-02-06

### Added

- Show factory-factory.json preview on new workspace page (#709)
- Add missing workspace attention glow animation (#731)

### Changed

- Enable noUncheckedIndexedAccess for safer array/object indexing (#741)
- Simplify ratchet flow and unify working-state derivation (#711)
- Improve attachments (#701, #714)
- Extract workspace list page subcomponents + shared create hook (#703)
- Stay on kanban view when starting workspace from GitHub issue (#653)
- Consolidate fixer sessions and PR snapshot writes (#691, #697)
- Enable text selection in toast notifications (#718)

### Fixed

- Fix ratchet missing repeated CI failures (#736)
- Fix Claude process timeout during workspace initialization (#729)
- Fix unhandled promise rejection from ClaudeClient error events (#717, #721)
- Fix Claude keepalive activity timeout (#712)
- Fix unhandled promise rejection from stdin stream errors (#702)

### Refactored

- Phase 3: Schema cleanup and legacy surface removal (#693, #719)
- Phase 2: Unify workspace creation orchestration (#692, #706)
- Remove workflow/session selectors and default session startup (#720)
- Remove adaptLegacyCreateInput compatibility path (#713, #715)

## [0.2.1] - 2026-02-05

### Added

- Data import option to initial project setup screen (#665)
- Domain model consolidation design documentation (#695)

### Changed

- Bump process memory limit from 2GB to 10GB to reduce OOM kills (#696)
- Make ratchet review fixer fully autonomous - no longer asks for user input (#690)

### Fixed

- Fix sendMessage unhandled promise rejections when protocol stream breaks (#696)
- Fix ratchet state update to only occur after confirmed message delivery (#696)
- Fix placeholder PR number in pr-review-fix prompt to dynamically resolve from current branch (#690)

### Refactored

- Refactor slash command palette key handling to reduce complexity (#649)
- Refactor GitHub CLI error classification to reduce complexity (#652)

## [0.2.0] - 2026-02-05

### Added

- Unified Ratchet system for PR automation (#565)
- Live agent activity dock (#639)
- Rendered plan view with inline expansion (#597)
- Data export/import for database backup and restore (#617)
- Workspace-level ratcheting toggle (#657)
- Ratchet visual indicators with animated border (#659, #660)
- Pulsing red glow to waiting workspaces in sidebar (#663)
- Temporary ratcheting animation after git push (#661)
- Auto-start agent with GitHub issue prompt when starting from Kanban (#642)
- Auto-start Claude session during workspace init (#621)
- Prisma migration drift check (#630)
- Use icons for session tab status (#640)

### Changed

- Simplify ratchet UX and behavior (#678)
- Simplify kanban board to 4 columns with GitHub issues (#638)
- Make workspace attention glow event-driven (#682)
- Limit waiting workspace pulse animation to 30 seconds (#676)
- Replace marching ants animation with yellow spinner (#662)
- Remove deprecated CI and PR Review settings sections (#658)
- Standardize tab button and prompt card UI (#612, #624)
- Improve question/plan prompts for chat input (#595)
- Place new workspaces at top (#594)
- Add PR reference comment instead of closing issue when PR is merged (#637)
- Close associated GitHub issue when archiving workspace (#632)
- Detect workspace worktree branches as auto-generated (#634)
- Use pnpm exec for lint-staged hook (#650)

### Fixed

- Fix ratchet agent not running after prompt submission (#673)
- Fix ratchet service to detect line-level review comments (#664)
- Detect edited PR comments in ratchet system (#683)
- Fix thinking streaming display (#641)
- Add missing migration (#629)
- Override brace-expansion to 5.0.1 (#622)

### Refactored

- Refactor chat input UI composition complexity (#573, #655)
- Unify diff parsing/rendering utilities (#611, #680)
- Consolidate date formatting utilities (#675)
- Simplify chat hooks by extracting sub-hooks (#614, #667)
- Split workspace detail container + move auto-scroll hook (#600, #671)
- Refactor chat reducer dispatch complexity (#572, #636)
- Refactor PR diff line rendering to remove Biome ignore (#570, #635)
- Refactor chart tooltip rendering complexity (#577, #633)
- Refactor agent activity renderers into modules (#609, #626)
- Refactor claude-types message checks complexity (#578, #627)
- Refactor session file logger summary extraction (#579, #628)
- Unify dev logs WebSocket hook with shared transport (#613, #619)
- Split admin route into sections and shared formatters (#620)
- Extract shared pathExists helper (#656)
- Extract tool truncation constants (#596)

### Documentation

- Update docs for ratchet, GitHub integration, and kanban (#677)

## [0.1.6] - 2026-02-03

### Added

- Resume existing branch flow (#583)
- GitHub Issues integration to workflow selector (#559)
- Drag-and-drop workspace reordering (#540)
- Automatic CI fixing sessions when CI fails (#495)
- Create PR button to workspace detail view (#500)
- Claude process status indicator (#536)
- Auto-detect GitHub owner/repo from git remote when creating projects (#582)
- Default workspace session creation (#584)
- Show startup script logs during workspace setup (#556)

### Changed

- Replace chat status bar with subtle tab status dot (#591)
- Persist tab scroll state across navigation (#585)
- Cache slash commands for offline palette (#535)
- Always play workspace completion sound regardless of focus or active workspace (#508)
- Move Create PR button inline with workspace title (#538)
- Always show refresh button in factory config section (#527)
- Use small button size for new workspace button (#507)
- Stop dev process and close terminals when archiving workspace (#537)
- Commit on archive cleanup (#526)
- Update deps and polish reviews UI (#516)

### Fixed

- Fix session resume ordering (#593)
- Fix slash menu keyboard scroll (#592)
- Fix Claude status on reconnect (#588)
- Fix paste attachments without contentType (#587)
- Fix workspace archive failing when worktree is not a valid git repo (#557)
- Fix pasted text attachments not responding to interactive requests (#549)
- Fix migrations (add_auto_fix_ci_issues_setting) (#539)

### Refactored

- Split session service modules (#564)
- Refactor paste handling complexity (#566)
- Introduce AppContext wiring (#554)
- Refactor workspace services (#555)
- Decouple message state transport (#551)
- Decompose Claude client/process concerns (#553)
- Split workspace detail route (#550)
- Consolidate Claude protocol types (#552)
- Refactor chat message handlers into registry (#534)
- Consolidate chat protocol types (#533)
- Extract chat transport handling (#531)
- Split chat reducer slices into files (#530)
- Refactor message state machine (#529)
- Refactor chat reducer into slices (#524)
- Refactor cognitive complexity (#528)
- Remove addressable Biome ignores (#563)
- Remove Next directives and relax chunk warning (#532)

## [0.1.5] - 2026-02-02

### Added

- Undo support via rewind_files control request (#484)
- CI monitoring service with automatic session notifications (#465)
- Model usage and cost tracking to chat UI (#481)
- Large paste and drag-drop attachment support (#480)
- Keyboard shortcuts to chat bar (#497)
- Option to toggle completion sound in admin settings (#483)

### Changed

- Align sidebar workspace rows (#505)
- Align review UI with chat styling (#501)
- Unify New Workspace button behavior across UI (#474)
- Remove icon from Dev Logs tab, keep connection status dot (#482)

### Fixed

- Fix initial slash command loading (#509)
- Fix compaction flow and queue handling (#504)
- Fix assorted code review feedback (#510)
- Fix migration checksum handling (#499)
- Make WS session logging async and dev-only (#496)
- Fix PR merged state not showing in UI (#489)
- Fix workspace header controls layout consistency (#478)
- Fix session tab close requiring double-click (#477)

### Documentation

- Add agents guide and align contributing (#488)

## [0.1.4] - 2026-02-02

### Added

- Slash command discovery and autocomplete (#462)
- Workspace notification system for agent completion (#467)
- Shift+Tab keyboard shortcut to toggle plan mode (#464)
- Smart delta compression for WebSocket message replay (#441)
- Handle SDK events: context compaction, task notifications, and status updates (#461)
- Differentiate system message subtypes (#460)

### Changed

- Refactor chat-input.tsx into modular components and hooks (#472)
- Show branch name in sidebar instead of workspace name (#471)
- Align Claude Code message handling with official SDK (#446)
- Replace ultrathink suffix with SDK set_max_thinking_tokens (#458)

### Fixed

- Fix New Workspace button size in Kanban view (#475)
- Fix message ordering when mixing ordered and unordered messages (#473)
- Handle control_cancel_request and dismiss stale permission dialogs (#468)
- Fix diff vs main to prefer origin/main over local main (#469)
- Fix quick action not executing when clicked (#466)
- Fix ExitPlanMode and add comprehensive Zod schemas for tool inputs (#459)
- Fix code review issues: config caching, division by zero, and opacity inheritance (#445)
- Fix message ordering by using backend-assigned order instead of timestamps (#443)
- Fix node-pty spawn-helper permissions for npx installs (#442)
- Fix "Cannot read properties of undefined (reading 'length')" during tool streaming (#440)

## [0.1.3] - 2025-02-01

### Fixed
- User messages appearing at top instead of chronological position (#438)
- Express 5 sendFile requiring root option for SPA fallback (#437)

### Changed
- Grouped copy and cancel buttons for queued messages (#436)

## [0.1.2] - 2025-02-01

### Added
- Message state machine for unified chat message tracking (#426)
- Terminal tabs inline in bottom panel tab bar (#420)
- Quick actions dropdown to chat bar (#414)
- Cancel button for inline queued messages (#433)

### Fixed
- Spinner not showing for subsequent messages in chat session (#434)
- Queued messages losing styling after workspace navigation (#431)
- Fetch latest from origin when creating git worktrees (#428)
- Caching issues requiring hard refresh after deployments (#421)
- Diff viewer line numbers overlapping for large files (#418)
- Message handling during AskUserQuestion and ExitPlanMode prompts (#405)
- Queued messages disappearing on page refresh (#411)
- Memory leaks from uncleared intervals/timeouts in RateLimiterService (#410)
- Spurious warning when archiving workspace (#417)
- Empty catch blocks with proper error handling (#413)
- Unhandled NotFoundError when refreshing during session startup (#408)
- Security vulnerabilities via pnpm overrides (#404)
- Code scanning security alerts (#401)

### Changed
- External link icon added to GitHub link with reduced footer padding (#419)
- Type safety improvements for WebSocket handlers and chat state management (#415)
- Consolidated terminal/devlog panel into single row (#409)
- Replaced phase label with GitHub repo link in sidebar footer (#416)
- Skip archive confirmation for workspaces with merged PRs (#406)
- Removed padding from PR link button in sidebar (#432)
- Removed unused Claude message state machine methods (#430)

### Infrastructure
- Automatic tag creation added to npm publish workflow (#422)
- Screenshot added to README (#403)

## [0.1.1] - 2025-01-31

- Initial npm release
- NPX distribution support (#400)

## [0.1.0] - 2025-01-31

### Added

- **Workspace Management**: Create isolated git worktrees for parallel development
- **Claude Code Integration**: Real-time streaming chat with Claude Code CLI
- **Terminal Sessions**: Full PTY terminal per workspace
- **Session Persistence**: Resume previous Claude sessions
- **Electron App**: Cross-platform desktop application (macOS, Windows, Linux)
- **Web App**: Browser-based interface with hot reloading
- **CLI Tool**: `ff` command for server management
- **Image Upload**: Attach images to chat messages
- **Markdown Preview**: Live preview with Mermaid diagram support
- **Extended Thinking**: Real-time thinking display for extended thinking mode
- **Task Tracking**: Visual panel for tracking tool calls and tasks
- **Quick Actions**: Fetch & rebase, and other common operations
- **Branch Renaming**: Automatic branch name suggestions based on conversation
- **Project Configuration**: `factory-factory.json` for project-specific settings

### Features

- Multiple Claude Code sessions running in parallel
- Each workspace gets its own git branch and worktree
- WebSocket-based real-time communication
- SQLite database for session and workspace persistence
- GitHub CLI integration for PR workflows
- Model selection (Claude Sonnet, Opus, Haiku)
- Dark/light theme support

### Developer Experience

- TypeScript with strict mode
- Biome for linting and formatting
- Vitest for testing
- Storybook for component development
- tRPC for type-safe APIs
- React Router v7 for routing
- Tailwind CSS v4 for styling
