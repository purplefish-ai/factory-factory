# Core Library Extraction

This directory contains stage-by-stage design documents for extracting `@factory-factory/core` from the monolithic Factory Factory codebase, as outlined in the [Cloud Vision](../factory-factory-cloud-vision.md) document.

## Goal

Convert the single-package repo into a pnpm monorepo with a publishable `@factory-factory/core` library containing workspace, session/claude, and ratchet domain logic behind storage and infrastructure abstractions. The desktop app continues to work identically, importing core as a workspace dependency.

## Stages

| Stage | Name | Risk | Description |
|-------|------|------|-------------|
| [1](./stage-1-monorepo-scaffolding.md) | Monorepo Scaffolding | Very Low | pnpm workspace setup, `packages/core/` skeleton |
| [2](./stage-2-extract-enums-shared-types.md) | Extract Enums & Shared Types | Low-Medium | Framework-neutral enum definitions, pure shared functions |
| [3](./stage-3-storage-and-infra-interfaces.md) | Storage & Infrastructure Interfaces | Medium | Storage abstraction layer, Logger/Config interfaces, pure derivation functions |
| [4](./stage-4-claude-protocol-extraction.md) | Claude Protocol & Process Management | Medium-High | Extract `session/claude/` module and shared protocol types |
| [5](./stage-5-domain-services-extraction.md) | Domain Services Extraction | High | Extract ratchet, workspace state, and session services |
| [6](./stage-6-finalize-api-and-publish.md) | Finalize API, Tests, Publish | Low | Clean public API, integration tests, npm publish |

## Dependency Graph

```
Stage 1 -> Stage 2 -> Stage 3 -> Stage 4 -> Stage 5 -> Stage 6
```

Each stage keeps the app building and all tests passing.

## Key Decisions

- **GitHub domain stays in desktop** -- wraps `gh` CLI; cloud implements its own bridge
- **Terminal and run-script stay in desktop** -- PTY/native modules, local process management
- **`src/shared/` is not a separate package** -- types needed by core move there; frontend re-exports
- **Core has zero Prisma dependency** -- uses storage interfaces implemented by consumers
- **Core has zero singleton dependency** -- logger, config, etc. injected via interfaces
