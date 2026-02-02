# Contributing to Factory Factory

Thank you for your interest in contributing to Factory Factory! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- GitHub CLI (`gh`) - authenticated
- Claude Code - authenticated via `claude login`

### Development Setup

```bash
# Clone the repository
git clone https://github.com/purplefish-ai/factory-factory.git
cd factory-factory

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

## Development Workflow

### Running the App

```bash
# Web app (development)
pnpm dev

# Electron app (development)
pnpm dev:electron

# Production build
pnpm build
pnpm start
```

### Code Quality

Before submitting a pull request, ensure your code passes all checks:

```bash
# Run tests
pnpm test

# Watch tests while developing
pnpm test:watch

# Type checking
pnpm typecheck

# Lint and format
pnpm check:fix
```

### Database

```bash
# Run migrations
pnpm db:migrate

# Generate Prisma client after schema changes
pnpm db:generate

# Open Prisma Studio
pnpm db:studio
```

### Storybook

Use Storybook for UI development and to validate component changes:

```bash
pnpm storybook
```

## Pull Request Process

1. **Fork the repository** and create a new branch from `main`
2. **Make your changes** with clear, focused commits
3. **Run all checks** (`pnpm test`, `pnpm typecheck`, `pnpm check:fix`)
4. **Write or update tests** for your changes
5. **Add or update Storybook stories** for UI changes
6. **Update documentation** if needed
6. **Submit a pull request** with a clear description

### Commit Messages

Write clear, descriptive commit messages:

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Keep the first line under 72 characters
- Reference issues when relevant ("Fix #123")

### Code Style

- We use [Biome](https://biomejs.dev/) for linting and formatting
- Run `pnpm check:fix` to automatically fix issues
- Follow existing patterns in the codebase
- Use TypeScript strict mode
- Prefer Zod for schemas and validation; avoid raw typecasts

## Project Structure

```
src/
├── backend/          # Express + tRPC server
│   ├── claude/       # Claude Code integration
│   ├── trpc/         # tRPC routers
│   └── resource_accessors/  # Database queries
├── client/           # React frontend
│   ├── components/   # UI components
│   └── routes/       # Page routes
├── cli/              # Command-line interface
└── components/       # Shared UI components (shadcn/ui)

electron/             # Electron main process
prisma/               # Database schema and migrations
```

## Contributor Checklist

- Add or update tests and run `pnpm test` (use `pnpm test:watch` while developing)
- Add or update Storybook stories when UI changes are introduced (`pnpm storybook`)
- Run `pnpm typecheck` and `pnpm check:fix`
- Ensure schemas use Zod and avoid raw typecasts
- Update docs when behavior or commands change

## Reporting Issues

- Check if the issue already exists
- Use the issue template if available
- Include steps to reproduce the issue
- Include your environment details (OS, Node version, etc.)

## Feature Requests

We welcome feature requests! Please:

- Check existing issues first
- Describe the use case clearly
- Explain why this feature would be useful

## Questions?

Feel free to open a discussion or issue if you have questions about contributing.

## License

By contributing to Factory Factory, you agree that your contributions will be licensed under the MIT License.
