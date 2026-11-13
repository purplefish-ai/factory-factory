# PR updates neither grant nor withdraw merge authorization

Originally decided on 2026-11-04 in #3040.

## Context

PR update messages used to say "Do not merge automatically". That contradicted
an earlier instruction from the user, such as "create a PR and merge when
green", and the agent followed the newer text. The updates also carry review
comments and CI output that anyone with access to the PR can write.

## Decision

Every PR update, in both delivery destinations and in legacy enablement
controls, says that PR updates do not grant merge authorization and tells the
agent to preserve the user's existing instructions, including any earlier
authorization to merge when checks pass. GitHub feedback is presented as
untrusted data and can never authorize a merge.

## Consequences

- Whether an agent may merge depends only on what the user told it.
- New prompt wording for PR updates must keep both sentences; the prompt tests
  in `src/backend/prompts/pr-event.test.ts` fail without them.
