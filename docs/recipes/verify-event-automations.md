# Verify event automations

## Use when

You changed the event automation runtime, its jobs or its GitHub source, and
need the checks that cover them.

## Steps

1. Run the end-to-end suites. They drive a saved GitHub automation through
   Enable, the runtime's registered jobs and the history reads, with fake
   GitHub, Git, classifier and provider transport; the runtime is composed by
   `src/backend/orchestration/testing/agent-runtime-flow.test-support.ts` as
   `src/backend/app-context.ts` composes it. Both test files must report passed.

   ```sh
   pnpm vitest run src/backend/testing/agent-runtime-flow.integration.test.ts src/backend/testing/agent-runtime-flow-launch.integration.test.ts
   ```

2. Optionally, check the issue-event parser against a real repository's feed. It
   reads up to three pages with your local `gh` login and writes nothing to
   GitHub. Use a throwaway repository with some labeled and reopened issues;
   never run it in CI. The test file must report passed, not skipped.

   ```sh
   AGENT_LIVE_GITHUB_REPO=owner/name pnpm test:integration src/backend/services/github/service/github-cli-agent-issue-events.manual.integration.test.ts
   ```

## Mistakes this prevents

- Running the live GitHub check in CI, or against a repository you care about.
- Looking for a live Slack check: there is none. Slack is checked only against
  the fake socket and web client in the agent-definition capsule's tests.
