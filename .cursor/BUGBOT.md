# Bugbot Review Guidance

Use the repository's [agent guide](../AGENTS.md) and the applicable
[backend service](../src/backend/services/AGENTS.md) or
[client feature](../src/client/features/AGENTS.md) guide for current
conventions. Use [architecture notes](../docs/architecture/README.md) for
subsystem contracts.

Focus review on actionable correctness, security, and regression risks:

- Preserve service ownership and public API boundaries. Database access belongs
  in the owning service capsule's `resources/`; cross-service coordination
  belongs in `src/backend/orchestration/`.
- Validate external input, file paths, WebSocket messages, and shell arguments
  at their boundaries. Worktree file operations must stay within the intended
  workspace, and credentials must not reach logs or commits.
- Check session lifecycle, cancellation, replay, and reconnect behavior for both
  Claude and Codex through ACP. Review browser and Electron differences when the
  changed behavior depends on their runtime or filesystem.
- Check that changed behavior has focused regression coverage and that Prisma
  schema changes include the required migration and generated output.

Report the concrete trigger and impact with a file reference. Avoid speculative
findings, stylistic preferences, and duplicate summaries of enforced rules.
