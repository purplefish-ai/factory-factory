# Voice Worklet Cleanup Design

## Problem

Voice capture installs an `AudioWorkletNode.port.onmessage` callback that can
invoke the barge-in speech callbacks. Cleanup closes the port and disconnects
the worklet, but a message task queued before shutdown can still reach the
installed handler. Because the handler captures a detector reference that is
separate from the hook-owned ref cleared during cleanup, a stale callback can
suppress playback in a later voice session.

## Design

`disposeCaptureResources` will detach the worklet port's `onmessage` handler
before closing the port and disconnecting the node. This matches the existing
WebSocket teardown pattern in the same function and prevents queued worklet
messages from crossing the capture lifecycle boundary.

No hook state, detector behavior, or audio graph setup changes are required.
The cleanup helper will be exported for a focused co-located unit test, as the
same module already exports an internal message-handler helper for testing.

## Testing

The regression test will create a fake worklet whose message handler represents
a speech callback, dispose its resources, and then simulate delivery of a
queued message through the port's current `onmessage` property. The callback
must not run, while port closure and node disconnection must still occur. The
test must fail against the current implementation and pass after detachment is
added.

## Edge Cases

- Cleanup with no worklet remains a no-op through the existing nullable
  resource contract.
- Detachment happens before `close()` so synchronous or queued delivery cannot
  observe the stale handler during shutdown.
- Existing cleanup of the silent gain, audio context, media tracks, and socket
  remains unchanged.
