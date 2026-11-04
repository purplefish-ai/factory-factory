# Application update prompts implementation record

This is the historical execution record for the
[November 4 design](../specs/2026-11-04-application-update-prompts-design.md),
not an active checklist. Current contracts live in
[Updating](../../../README.md#updating),
[Agent Runtime](../../architecture/agent-runtime.md), and
[Background Jobs](../../architecture/background-jobs.md).

## Original scope and authorization

The user approved implementation, PR creation, and conditional merge after
verification and review. That approval describes the original delivery scope;
this record does not independently authorize future publication or merging. The
existing isolated worktree was selected for implementation.

## Execution rationale

The work was split into shared contracts and cached release detection, shared
banner notices, CLI-supervised installation and recovery, and integration
verification. Separating registry lookup from installation let unavailable
metadata remain nonblocking. A supervisor outside the backend kept recovery
possible across package replacement and backend startup failure.

Review emphasized concurrent requests, admission races, migration recovery, and
idle ACP processes. The resulting durable contracts are documented in the
current architecture notes instead of duplicated here.

## Integration context

PR #2972 introduced a basic release banner while this work was underway. The
integration decision was to extend its existing `factory-update-banner`, retain
its per-release dismissal key as a compatibility fallback, and show one shared
prompt. The new CLI prerequisite checks from PR #2973 were preserved.
