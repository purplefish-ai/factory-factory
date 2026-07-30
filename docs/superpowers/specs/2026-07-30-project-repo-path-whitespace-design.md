# Project Repository Path Whitespace Design

## Problem

The new-project page treats a whitespace-padded local repository path inconsistently. It
uses `repoPath.trim()` to reject blank input, but sends the original value to both the
project creation mutation and the debounced factory-config query. The project creation
router also accepts and forwards the untrimmed value. Filesystem consumers therefore
look up a different path from the one the user intended, and derived project metadata can
inherit trailing whitespace.

## Design

Normalize the local repository path at every boundary introduced by this flow:

- The client debounce stores `repoPath.trim()` so live factory-config detection receives
  the intended path and disables itself for whitespace-only input.
- The local submit handler computes the trimmed path once, uses it for required-field
  validation, and submits it to the create mutation.
- The project creation input schema applies Zod's `.trim()` before `.min(1)` so direct
  callers cannot bypass normalization and whitespace-only input receives the existing
  required-path error.

The update and standalone validation routes are outside this issue because they are not
part of project creation or its live config check.

## Error Handling and Edge Cases

- Leading and trailing whitespace is removed; internal whitespace remains unchanged.
- Whitespace-only input is treated as missing on both client and server.
- Existing startup-script trimming and selection behavior remains unchanged.
- Electron directory-picker values pass through unchanged unless they contain accidental
  surrounding whitespace.

## Testing

Add component-level regression tests proving that the page sends a trimmed path to the
create mutation and, after the debounce, to `checkFactoryConfig`. Add router coverage
proving that create validation and persistence both receive the trimmed value and that a
whitespace-only value is rejected before any service call.

No screenshot is required because the rendered UI and copy do not change.
