# Changelog

All notable changes to Factory Factory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
