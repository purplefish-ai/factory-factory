# Child Workspace Report-Back Prompt Design

## Problem

Child workspace creation persists `initialPrompt` and `reportBackOn` in workspace creation metadata. Workspace initialization sends `initialPrompt` through the session message queue, but `reportBackOn` is only included in `AcpClientOptions.systemPrompt`. The ACP `newSession` and `loadSession` requests have no system-prompt field, so that instruction never reaches the child agent.

## Selected Design

Extract the existing child-workspace context wording from `SessionPromptBuilder` into a pure exported helper in the session service capsule. Keep `SessionPromptBuilder` using that helper so its current output remains consistent. During default session startup, resolve the child workspace's parent and optional string `reportBackOn`, build the same context, and prepend it to the message sent through the existing queue pipeline.

The queued context is delivered even when the child has no `initialPrompt`, an empty prompt, a whitespace-only prompt, or only attachments. Non-child workspaces retain their existing initial-message behavior.

## Alternatives Considered

1. **Duplicate the context text in workspace initialization.** This is the smallest local edit, but two copies could diverge and produce different agent instructions.
2. **Pass `systemPrompt` to ACP session creation.** ACP's `NewSessionRequest` and `LoadSessionRequest` do not support this field, so this cannot solve the bug within the current protocol.
3. **Rewrite `creationMetadata.initialPrompt` during child creation.** This would alter persisted user input and couple creation to presentation wording. Queue-time composition preserves raw metadata and follows the issue's requested delivery point.

## Data Flow

1. `WorkspaceCreationService` persists `parentWorkspaceId`, optional `initialPrompt`, and optional `reportBackOn`.
2. `startDefaultAgentSession` loads the child workspace and its parent/project summary.
3. The shared helper builds generic reporting guidance and appends `Report back when: ...` only for a non-empty string instruction.
4. Workspace initialization prepends that context to the resolved initial message, preserving attachments.
5. `enqueueAutoMessage` sends the combined text through the normal queue and replay path.

## Error Handling and Compatibility

- A missing parent lookup uses the existing `unknown` and `unknown project` fallbacks.
- A non-string `reportBackOn` value is ignored.
- Failure to enqueue continues to use the existing warning behavior.
- The change does not attempt to repair other dead `systemPrompt` content such as workflow, branch-rename, or dev-server instructions.
- There is no UI behavior change, so screenshots are not applicable.

## Tests

- Prove a child initial prompt is queued after the child context and includes parent/project names plus `reportBackOn`.
- Prove child context is queued when no initial prompt exists.
- Prove regular workspace prompt behavior remains unchanged through the existing tests.
- Run focused Vitest tests, type checking, formatting/lint fixes, the full test suite, and the production build.

## Known Baseline

Before implementation, `pnpm test` reports 14 unrelated failures: 13 React tests fail because `act` is not a function, and one shell timeout test observes `SIGTERM` instead of `SIGKILL`. The child-workspace orchestration suite is not among the failures.
