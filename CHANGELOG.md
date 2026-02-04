# Changelog

All notable changes to Factory Factory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
