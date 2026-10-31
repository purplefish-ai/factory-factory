# Stable thinking preview

Keep the live thinking preview above the composer, outside the scrolling
transcript, in workspace chat and quick chat. Reserve a fixed single-line slot
while idle so wrapping and completion cannot change the viewport height. Fade
contents over 150 ms, respecting reduced motion. Let users inspect the full
preview without changing layout. Preserve background-task and sub-agent controls
and the existing behavior of read-only transcripts.

## Approaches

The user chose a reserved composer area over reserving space inside the
transcript. The latter still moves status content between virtual rows.
Animating transcript height alone leaves the underlying movement in place.

## Implementation choices

Use the shared ChatTranscript to own an optional footer, with a dedicated
thinking-preview component. Keep the existing transcript activity indicator as
the default for consumers without a composer. Do not change scroll policy.
