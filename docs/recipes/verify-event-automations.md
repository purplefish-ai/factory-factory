# Verify event automations

Checks to run after changing the event automation runtime, its jobs or its
GitHub source.

1. Run the end-to-end suites. They drive a saved GitHub automation through
   Enable, the runtime's registered jobs and the history reads, with fake
   GitHub, Git, classifier and provider transport; the runtime is composed by
   `src/backend/orchestration/testing/agent-runtime-flow.test-support.ts` as
   `src/backend/app-context.ts` composes it.

   ```sh
   pnpm vitest run src/backend/testing/agent-runtime-flow.integration.test.ts src/backend/testing/agent-runtime-flow-launch.integration.test.ts
   ```

2. Optionally, check the issue-event parser against a real repository's feed. It
   reads up to three pages with your local `gh` login and writes nothing to
   GitHub. Use a throwaway repository with some labeled and reopened issues;
   never run it in CI.

   ```sh
   AGENT_LIVE_GITHUB_REPO=owner/name pnpm test:integration src/backend/services/github/service/github-cli-agent-issue-events.manual.integration.test.ts
   ```

Slack is checked only against the fake socket and web client in the
agent-definition capsule's tests; there is no live Slack check here.
