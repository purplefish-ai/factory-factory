# The attention glow fades while input is pending

Originally decided on 2026-11-04 in #2967.

## Context

When a session starts waiting for a permission, an answer or a plan approval,
the sidebar glows on its workspace (`useWorkspaceAttention`). Sessions can wait
for input for a long time, and several workspaces can wait at once.

## Decision

The glow still fades after 30 seconds, even while the request is pending. A
pending-request transition dispatches an attention event without the completion
sound. What lasts until the request resolves is the workspace's pending-request
icon in the sidebar and the awaiting-input status on its chat tab.

Rejected: a glow that lasts until the request resolves, which would keep
animating for every blocked workspace.

## Consequences

- A user who misses the 30-second glow finds a waiting workspace by its icon and
  tab status, not by motion.
