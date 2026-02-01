# Changelog

All notable changes to Factory Factory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
