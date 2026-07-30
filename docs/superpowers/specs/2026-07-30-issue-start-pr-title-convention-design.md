# Issue-Start PR Title Convention Design

## Goal

Update the shared issue-start prompt so agents use a repository's documented pull-request title convention when one is available. If the repository does not specify a convention, agents must retain the current title format:

```text
Fix <issue reference>: [concise description]
```

## Scope

Change `buildIssueStartPrompt` in `src/shared/issue-start-prompt.ts`. This builder supplies the initial workflow for workspaces started from both GitHub and Linear issues.

Do not change the generic Feature workflow in `prompts/workflows/feature.md`.

## Prompt Behavior

In Phase 5, immediately before the `gh pr create` command, add a dedicated PR-title selection step:

1. Check repository instructions and contributor documentation for a specified PR-title convention.
2. Follow that convention when present.
3. Otherwise use the existing `Fix <issue reference>: [concise description]` format.
4. Pass the selected title to `gh pr create`.

This is prompt guidance only. Factory Factory will not inspect, parse, or enforce repository-specific title conventions at runtime.

## Testing

Extend `src/shared/issue-start-prompt.test.ts` with a focused assertion that the generated prompt:

- prioritizes a convention specified by repository instructions or contributor documentation;
- explicitly retains `Fix #1724: [concise description]` as the fallback for the test fixture; and
- directs `gh pr create` to use the selected title.

The existing issue-data security-boundary tests remain unchanged.
