# Slack triggers activate on a posted test message

Originally decided on 2026-11-12 in #3191 (event automations, #2772).

## Context

An event trigger starts listening at an activation boundary: nothing before it
may run. A GitHub trigger takes its boundary from a baseline of the issue-events
feed. A Slack trigger has no provider feed to take a baseline from.

## Decision

Enable gives the trigger a fresh code and the user posts
`Factory Factory check <code>` in each selected channel. The message proves that
Slack delivers that channel's messages to this app, and its provider timestamp
becomes that channel's boundary. The trigger activates once every channel has
its message, or returns to Paused when the window ends first.

## Consequences

- The code proves delivery, not identity: it is safe to post and grants nothing.
- Re-enabling issues a new code, so an earlier test message cannot activate the
  trigger, and messages from the paused period stay before the new boundaries.
