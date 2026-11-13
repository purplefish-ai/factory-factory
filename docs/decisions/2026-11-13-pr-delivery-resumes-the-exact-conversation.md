# PR delivery resumes the exact stored conversation

Originally decided on 2026-10-14 in #2447.

## Context

After a backend restart a recipient has no live provider process. Starting a
fresh provider conversation would deliver the update to an agent that has lost
the task's context, and it would make receipt proof impossible because the
frozen delivery names the original conversation.

## Decision

Cold delivery resumes the exact stored Claude or Codex conversation and restores
its saved model, mode, reasoning and permission settings. A failed or
unsupported resume never falls back to a new conversation; it pauses delivery as
`RESUME_FAILED` with the events kept. PR updates never apply separate Ratchet
provider or permission defaults.

## Consequences

- A conversation whose provider history is gone cannot receive PR updates until
  the user resumes or rebinds it.
- Dedicated conversations reuse their saved provider identity and settings even
  when workspace defaults have changed since they were created.
