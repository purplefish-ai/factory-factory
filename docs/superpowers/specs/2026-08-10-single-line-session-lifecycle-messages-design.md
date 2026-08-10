# Single-Line Session Lifecycle Messages

## Goal

Render session lifecycle messages as compact single-line rows, with the event time aligned to the far right and kept visible at narrow widths.

## Scope

Change only `SessionLifecycleMessageRenderer`. Preserve the existing icon, severity styling, lifecycle copy, timestamp format, spacing container, and accessibility attributes.

## Layout

The row uses a horizontal flex layout with three items:

1. A non-shrinking severity icon.
2. A flexible message label that may shrink and truncates with an ellipsis.
3. A non-shrinking timestamp aligned at the far right.

The message and timestamp remain on one line. When horizontal space is limited, only the message truncates; the timestamp remains fully visible.

## Implementation

Flatten the existing nested message-and-time block into sibling elements in the row. Align the row contents vertically in the center. Apply the minimum-width and overflow utilities needed for ellipsis truncation to the message, and prevent the timestamp from shrinking or wrapping.

No data flow, protocol, formatting, or error-handling behavior changes.

## Testing

Add a focused renderer test that asserts the structural styling contract responsible for the one-line layout:

- The row vertically centers its children.
- The message is flexible and truncated.
- The timestamp does not shrink or wrap.

Retain the existing tests for lifecycle copy, severity, and decorative icon behavior. Run the focused renderer test, client type checking, and repository checks appropriate to the changed files.
