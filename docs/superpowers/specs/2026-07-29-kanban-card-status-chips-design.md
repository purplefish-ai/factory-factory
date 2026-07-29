# Kanban Card Status Chips

## Goal

Make Kanban cards easier to scan by presenting one canonical workspace status,
removing the duplicate “Waiting for CI” and “CI Running” treatments, and placing
linked issue and pull request metadata on one line.

## Scope

This is a presentation-only change to the Kanban card. The shared workspace
status-reason derivation, Kanban column projection, snapshot payload, and other
workspace surfaces remain unchanged.

## Status presentation

Each Kanban card renders exactly one workspace status chip. The chip uses the
card's existing `statusReason`, which already resolves precedence among setup,
agent activity, pending user actions, CI flow, pull request state, and terminal
states.

The Kanban card maps `WAITING_FOR_CI` to the label “CI Running.” Other reasons
use their existing labels, including “Agent working,” “Needs permission,”
“Ready to merge,” and “Merged.” This label override remains local to the card so
other surfaces do not change wording.

The chip's visual treatment follows the existing status-reason tone:

- `working` uses the active/brand treatment.
- `waiting` uses the in-progress CI treatment.
- `attention` uses the warning treatment.
- `success` uses the success treatment.
- `danger` uses the error treatment.
- `neutral` uses the subdued treatment.

The card no longer renders separate setup and CI status rows. A draft pull
request may retain its inline “Draft” qualifier next to its PR metadata because
that describes the pull request, not the workspace's canonical status.

Session runtime errors retain their detailed message as supporting metadata,
while the canonical status chip reads “Session error.” The detailed message is
not a second status.

## Metadata layout

When present, the linked issue and pull request appear in one compact,
horizontally wrapping metadata row. Each remains an independent button with its
existing icon, label, external-navigation behavior, and event propagation
guards.

The branch stays on its own row beneath the issue/PR row so long names can
truncate without crowding the links. Auto-iteration, child-workspace, and
runtime-error metadata keep their existing behavior.

The card content order is:

1. Canonical status chip.
2. Issue and pull request links.
3. Branch.
4. Auto-iteration, child-workspace, and runtime-error details when applicable.

## Component boundaries

`KanbanCard` owns the card-local status label override and layout. A small
status-chip component converts a `WorkspaceStatusReason` into the shared chip
shape and tone classes. A combined metadata-row component composes the existing
issue and pull request link behavior.

No new cross-feature API or backend field is introduced.

## Testing

Component tests will establish that:

- a card renders one canonical status chip;
- `WAITING_FOR_CI` displays “CI Running” without a duplicate CI treatment;
- agent and actionable states use their status-reason labels;
- setup and idle states also receive one canonical chip;
- issue and pull request controls share one metadata row and retain independent
  external-link behavior;
- a session error renders one status chip plus its detailed message.

Storybook stories will continue to cover representative working, CI, setup,
issue, pull request, and terminal states, with a combined issue-and-PR example
for visual review.

## Non-goals

- Changing status-reason precedence or Kanban column assignment.
- Changing shared status labels outside Kanban cards.
- Redesigning card title actions, branch metadata, or archive behavior.
- Changing how issue or pull request links navigate.
