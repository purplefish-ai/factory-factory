# Ratchet Provider-Mismatch Cleanup Design

## Goal

Ensure a provider-mismatched Ratchet fixer session is stopped even when its
workspace check is cancelled while the dispatch record is being settled.

## Root Cause

`checkActiveFixerSession` settles a provider-mismatched dispatch before it
stops the session. If cancellation occurs during `recordSessionEnd`, the write
can commit and the following abort check throws before the stop helper is
called. The dispatch is then `DIED` while the mismatched session remains
`RUNNING`.

The stop helper is also abort-sensitive even though it is cleanup code that is
intended to be best-effort and never throw. Its abort checks can prevent the
stop attempt or replace a stop failure warning with a cancellation exception.

## Design

Keep cancellation barriers around ordinary Ratchet work, including before
settlement and after `recordSessionEnd`. Make session stopping abort-insensitive:
`safeStopSession` will always attempt `sessionBridge.stopSession`, catch every
failure, and log the existing warning context.

For the provider-mismatch branch, run the stop helper in a `finally` block
around settlement. This preserves the existing settlement-before-stop ordering
and preserves the cancellation rejection, while guaranteeing that cleanup is
attempted whenever execution has reached the provider-mismatch branch.

The change is deliberately limited to provider-mismatch cleanup. It does not
change timeout duration, provider resolution, dispatch outcome selection, or
pre-settlement cancellation behavior.

## Error Handling

- Cancellation observed after a committed settlement remains the caller-visible
  error after cleanup finishes.
- A stop failure is logged with the existing warning message and context.
- A stop failure never masks a settlement or cancellation error.
- Cancellation before provider mismatch is established still prevents
  settlement and cleanup side effects.

## Testing

Add a service-level regression test that aborts during
`recordSessionEnd('DIED')`, asserts that the check rejects with the timeout
reason, and asserts that `stopSession` was still called for the mismatched
session. Existing tests continue to cover normal mismatch settlement and
pre-settlement cancellation.
