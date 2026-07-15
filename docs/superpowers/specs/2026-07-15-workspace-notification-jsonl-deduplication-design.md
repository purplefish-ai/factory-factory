# Workspace Notification JSONL Deduplication Design

## Problem

Pending workspace notifications are re-enqueued after a session transcript is hydrated from provider JSONL when the original delivery completed but `markDelivered` failed. Live transcript entries retain Factory Factory's `workspace-notification-{notificationId}` ID, but JSONL hydration rebuilds user entries from provider UUIDs. The current exact-ID-only check therefore misses the already-delivered prompt.

## Constraints

- Preserve exact-ID deduplication for live Factory Factory transcript entries.
- Recognize JSONL-hydrated user prompts even when their IDs are provider-generated.
- Never treat agent/UI workspace-update cards as proof that the prompt reached the provider.
- Do not change the ACP/provider protocol in this fix. ACP 0.15's unstable optional `messageId` requires UUID format, while Factory Factory notification queue IDs are not UUIDs, and provider persistence behavior is not a portable guarantee.
- Avoid schema changes and unrelated session-history changes.

## Considered Approaches

1. **Exact user-text fallback (recommended).** Build the canonical prompt text before the transcript check. Match a user transcript entry when either its ID matches the queue ID or its text exactly matches the canonical notification prompt. Track provider-ID transcript matches during one pending-delivery pass so a single history entry cannot satisfy multiple identical pending notifications. This is local, provider-independent, and directly covers persisted JSONL behavior.
2. **Propagate an ACP `messageId`.** Thread message identity through chat handlers, session service, runtime manager, both adapters, and JSONL loaders. The existing notification ID format violates ACP's UUID requirement, so this also needs a deterministic UUID mapping and provider capability/persistence validation. This is too broad and still cannot guarantee portable JSONL identity.
3. **Persist a separate delivery receipt.** Add durable state recording that provider prompt commit succeeded independently of `WorkspaceNotification.deliveredAt`. This would be robust but requires a schema and transaction/lifecycle redesign for a narrow recovery bug.

## Design

`SessionLifecycleService.deliverPendingChildNotifications` will compute each notification's canonical queue text before deduplication. The transcript helper will accept both `messageId` and `messageText`, examine only `source === 'user'` entries, and prefer an exact ID match. Exact-text fallback is enabled only when the transcript hydration source is `jsonl`, and `workspace-notification-*` entries are excluded from fallback so Factory queue IDs remain reserved for exact matching. The helper will return the matched transcript entry ID rather than a boolean so the caller can reserve provider-generated matches in a per-pass set.

Exact Factory Factory IDs remain authoritative and need no reservation because each notification has a unique queue ID. Provider-generated content matches are reserved so one JSONL entry cannot mark two same-text pending notification records delivered. If no eligible transcript entry exists, enqueue behavior remains unchanged.

## Error Handling

The existing best-effort `markDeliveredAfterTranscriptMatch` behavior remains unchanged: a transcript match suppresses re-enqueueing even if the retry to mark the notification delivered fails, and the failure is logged. Queue and accessor failures retain their current handling.

## Tests

Add focused lifecycle regressions that verify:

- A provider-UUID user entry with the exact parent notification prompt is marked delivered and not re-enqueued.
- A provider-UUID user entry with different text does not deduplicate the notification.
- One provider-UUID entry cannot deduplicate two identical pending notification records.
- Existing exact-ID and agent/UI-only behavior remains covered by the current tests.

No UI screenshots are applicable because the change is backend-only and has no visual behavior change.
