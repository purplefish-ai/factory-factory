# Changelog

All notable changes to Factory Factory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
