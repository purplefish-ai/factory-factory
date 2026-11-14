# Draft validation is a POST mutation

Originally decided on 2026-11-02 in #2794.

## Context

The saved event editor can preview a draft before it is saved: per-trigger
capability and the native model, effort and provider the automation would run
with. The preview needs the whole draft, and a draft's instructions can run to
50,000 characters. tRPC sends a query as a GET request with its input in the
URL, which is too short for such a draft.

## Decision

`automation.validateDraft` is a mutation, so the full draft travels in the
request body. The editor calls it only when the user asks for a preview.

Rejected: a query, which would put the instructions in the URL.

## Consequences

- The preview is never cached or refetched by the client; each request is an
  explicit user action.
- The preview grants nothing: Enable validates the saved configuration again on
  the server.
