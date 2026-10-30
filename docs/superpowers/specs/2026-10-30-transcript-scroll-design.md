# Transcript scroll ownership

Status: proposed; implementation is a separate task. The user approved planning
a full refactor after the initial investigation. This record and its companion
plan converged after three rounds of independent review, with no remaining HIGH
or MEDIUM concerns. Implementation has not started.

## Intent

Make the main chat panel predictable during streaming, rapid tool calls,
resizing, hydration, and pane switches. Preserve the reader's place and avoid
scroll corrections that fight their input. Share the resulting behavior with
other consumers of the live transcript renderer.

The central invariant is that layout changes do not change user intent.
Following the latest output and reading an earlier position are explicit modes.
Whether a viewport happens to be near its bottom is a measurement, not a second
owner of those modes.

## Evidence from the current implementation

- `use-auto-scroll.ts` keeps proximity state independently from the message
  list's proximity ref. It samples geometry in a deferred frame.
- `virtualized-message-list.tsx` separately scrolls on row-count changes,
  reasoning changes, and content resizes. A tool sequence can grow without its
  row count changing.
- Its resize callback subtracts the most recent growth from the entire pending
  bottom gap. Multiple callbacks before a correction can incorrectly clear
  following. A temporary diagnostic reproduced the lost append-follow decision.
- A queued resize correction checks hydration but not a subsequent user scroll.
  A temporary diagnostic reproduced the resulting unwanted jump.
- Main chat restoration depends on raw `messages.length`, so restoring saved
  offsets competes with ongoing output. The saved offset is only pixels.
- Chat stays mounted under `display: none` when another main-view pane is
  active. Its message-list scroll effects do not receive that visibility state.
- Composer resizing writes directly to the viewport. The main jump button also
  changes the viewport height when it appears.
- The existing focused suites passed 34 tests; they mock the virtualizer and do
  not establish real-browser measurement or event ordering correctness.

## Behavior contract

1. New live main and quick chats start following. A subagent transcript retains
   its current initial reading behavior; it does not acquire an automatic
   first-open jump merely because it adopts the shared component.
2. Following stays attached through appended rows, growth inside one grouped
   tool row, reasoning/status changes, async image sizing, content shrinkage,
   composer changes, and viewport width/height changes.
3. Upward user scrolling yields immediately. Wheel/touch/keyboard/scrollbar
   input cancels pending positioning before its queued correction can run.
   Merely clicking a tool, selecting text, or typing in the composer must not
   turn following off.
4. Downward user movement that returns within 24 CSS pixels of the end, or an
   explicit "Scroll to bottom" action, resumes following. Upward movement has
   priority over the proximity threshold. Use a 1 CSS pixel comparison epsilon.
5. Reading preserves a keyed visible row plus its viewport offset when earlier
   rows are remeasured or older history is prepended. Changes inside the visible
   grouped row preserve its row-relative offset; semantic anchoring to an
   individual tool call within that row is outside this refactor.
6. Returning to a pane restores its intent: following goes to the current end;
   reading restores its anchor. This is the proposed default from the initial
   discussion, not a separately stated user preference.
7. A hidden, zero-size, unmounted, or hydrating pane performs no app positioning
   or persistence. Loading queued messages can still render. Once active, data
   ready, storage ready, and nonzero-size, the controller restores against the
   current layout, then enables normal operation.
8. No message-count change starts another saved-position restore. A genuine
   identity change or activation does. Further measurement notifications can
   refine that same restore, rather than starting competing restores.
9. User takeover cancels restoration and commits the resulting reading position.
   Stale frames/listeners/cleanup from an old identity never affect the new one.
10. The jump control overlays the transcript and never resizes its viewport.
    Streaming, restore, and jump positioning use instant behavior. No new
    scrolling animations or dependencies are required.

## Chosen approach and alternatives

The initial recommendation, accepted for detailed planning, is a small policy
controller and React adapter around the installed TanStack virtualizer. Patching
the current effects leaves several owners and causal ambiguity. Reimplementing
virtualized positioning creates unnecessary measurement and browser complexity.

Installed `@tanstack/react-virtual` is 3.14.23 and its locked virtual core is
3.19.8. The installed source has end anchoring, follow-on-append, end scrolling,
and cancellation. Do not upgrade packages as part of this work. See the
[official chat guide](https://tanstack.com/virtual/latest/docs/chat) and
[API reference](https://tanstack.com/virtual/latest/docs/api/virtualizer).

## Ownership and public API

`chat` owns a public `ChatTranscript` component and the serializable
`TranscriptPosition` type. It owns the viewport DOM node, virtualizer,
controller, input observation, jump control, and transcript rendering. Consumers
supply display data and scroll lifecycle/storage capabilities. They cannot
independently write its scroll offset. The internal message-list renderer is no
longer a cross-feature API.

`createTranscriptScrollController` owns intent, lifecycle, cancellation,
restoration target, persistence permission, and one app invalidation frame.
`useTranscriptScroll` connects that controller to React, DOM events, the
virtualizer and observers. Position math/anchor conversion lives in a small
private helper. TanStack remains the positioning and measurement engine; the
controller does not duplicate its resize-delta compensation algorithm.

The controller and virtualizer have distinct responsibilities, not two
independent policies. Configure `anchorTo: 'start'` and `followOnAppend: false`
in all modes. Native end anchoring would otherwise use geometry to reattach a
reader during same-key growth, even with append-follow disabled. The controller
is the only follow policy: content measurements, structural changes and viewport
changes coalesce into one invalidation frame. In following mode, that frame uses
native `scrollToEnd` only if the viewport is not already within 1 pixel of the
end. Ordinary scroll events do not themselves invalidate layout. Publish size
invalidations after React commits the corresponding sizer, or retain their dirty
generation until that committed extent is evaluated. Reading stale DOM at a zero
bottom gap must not consume a pending growth notification.

In reading mode, preserve the last committed live anchor across actual
prepend/trim/reorder changes that affect its preceding rows. This correction
uses the current keyed model and input generation, not persisted initial state.
Same-key measurement changes use native compensation. Set the public
`shouldAdjustScrollPositionOnItemSizeChange` predicate to compensate rows fully
above the viewport (`item.end <= scrollOffset + 1`) even after upward movement;
do not compensate growth of the row spanning the visible anchor. Verify first
measurements, partially visible giant rows and native touch deferral in the
engine tests. This replaces the native default that skips some corrections
during backward scrolling.

Cancellation stops controller frames and native end/restore commands. Legitimate
native anchor-preserving compensation remains allowed. Wrap public `scrollToFn`
to record every native write/read-back, including adjustment writes and actual
clamped DOM coordinates, with identity and input generations. Delayed/coalesced
programmatic events and geometry-induced browser clamping cannot change intent.
Do not classify events using `isTrusted` or a one-frame programmatic flag. Do
not silently drop native adjustments while the engine advances its logical
offset.

Interaction begin cancels outstanding app/native commands and inhibits new app
positioning while retaining intent and any restoration target. Touch end/cancel
without movement resumes the retained target/intent. Real upward movement sets
reading; real downward movement near the end sets following. Directional upward
wheel/key input can establish reading before the native movement; ordinary
clicks cannot. Input episodes finish on pointer/touch end or native
scrollend/engine scroll-idle notification for wheel/keys. Start/refresh a
separate 150ms fallback from input itself and ongoing scroll activity: a
boundary wheel/key can emit no scroll event, so engine idle alone cannot end
inhibition. Explicit jump ends an input episode and follows. Anchor-preserving
engine compensation is allowed during a gesture, using the engine's native touch
deferral. Confirm all contracts against the real engine before deleting the old
implementation.

Every scroll position is scoped to workspace, transcript/session, and surface. A
keyed inner transcript instance prevents one identity's DOM and virtualizer
cache from leaking into another. Suspension within an identity preserves its
intent and last valid position, and disables virtualizer activity while hidden.

## Geometry

Use stable message/group keys and dynamically measured rows. Put status,
reasoning, compaction, initialization, and queued-PR tail content inside the
final message's measured row. When there are no messages, use a measured
status-only row. This keeps status sizing in the same measured extent without
adding an artificial persistent scroll target after the messages. Moving the
tail must not remount existing message-renderer children. The layout choice does
not depend on native append detection, which this design disables.

Place transcript header content in a measured leading row, including banner and
subagent history/error controls. Use virtualizer padding for transcript spacing,
so DOM extent and virtual extent describe the same content. Disable native CSS
scroll anchoring on the controlled viewport to avoid double compensation.
Observe viewport dimensions; composer/prompt/sidebar changes are thereby layout
invalidations rather than special scroll writers.

## Persistence and restoration

`TranscriptPosition` stores intent, a nonnegative pixel fallback, and an
optional `{ key, offset }` visible-row anchor. Restore by key, mount/measure the
target through the virtualizer, and refine to its row-relative offset. If the
anchor has disappeared after rewind/trimming, clamp the pixel fallback and
remain in reading mode. Do not convert clamping into new follow intent.

Main chat adapts the workspace panel's existing scroll storage. Add an optional
validated chat-position field to existing v1 entries; preserve code/markdown and
diff fields and keys. New chat position is authoritative when present. Legacy
`stickToBottom: true` becomes following, otherwise an existing entry becomes
reading at its pixels; no entry means the surface's initial intent. Validate
stored data with Zod and retain a valid pixel record if the optional anchor is
malformed. Main session close continues to delete `chat-<session>:chat` state.

Expose workspace-scoped scroll-storage readiness from the panel provider and
guard reads/writes by the originating workspace. Flush old workspace writes
before loading the next record. A callback created for workspace A must never
write into workspace B's record. Do not sample A's position from B's DOM after
selection changes; persist committed snapshots while A is still active.

Quick chat keeps a component-lifetime position map keyed by workspace/session;
it does not gain localStorage persistence. Subagent panes use the same engine,
keep their initial reading behavior and keyed prepend anchoring, and retain
their current lifetime of persistence. Static closed-session viewers, diffs,
files, terminals, and log streaming do not migrate to this controller.

Restoration is staged: resolve the key, issue one index command to mount an
unmeasured target, wait for measurement, then cancel that command and apply the
row-relative offset. Refine only when the measured target changes; do not issue
new index/offset commands every frame. Use this sequence for live structural
anchor corrections too, without reloading the persisted initial position.

Restoration is driven by data readiness and measurements, with at most one
pending app frame. A bounded attempt budget prevents a frame loop: after 12
unsuccessful attempts, cancel the native command, retain the target and wait for
a new measurement/layout notification. Exhausting the budget is not success and
does not persist a clamped intermediate position. A valid target within 1 pixel
over two measured frames is settled. Cancel the restore immediately on actual
user takeover. Track measurement validity by key, DOM node and width/layout
generation via a wrapper around the public native measurement callback. A newly
valid measurement must wake a stalled target even if its height exactly equals
the estimate and native total size/onChange does not change. This readiness
signal is separate from follow invalidation; identical measurements cannot loop.

Main readiness requires non-null selected identity,
`runtimeSessionId === selectedSessionId`, and reactive
`scrollLoadedWorkspaceId === workspaceId`. Quick chat uses the same hydration
identity check without a storage wait. Runtime phase alone is insufficient:
timeouts, disconnects and early runtime events can leave it non-loading before
the snapshot arrives. Subagent data is ready only in its `ready` state. Main
visibility uses the same `showChat` predicate as `MainViewContent`; mobile modal
occlusion alone does not create a new suspension contract.

`clearSession(sessionId)` revokes the specified session's persistence generation
before removing its entry, so late callbacks cannot recreate it. Closing an
inactive session must clear that session without touching the selected one.
Clear quick-chat map entries on session close too. Store that map in
`useQuickChat`/sheet ownership, which survives content unmount on sheet close.
Emit snapshots only from settled ready state after actual reader movement,
intent change, completed restore, or settled anchor-preserving geometry changes;
coalesce and skip identical snapshots.

## Verification and acceptance

Use deterministic controller/adapter tests for intent, identity and
cancellation; storage tests for migration/validation/workspace isolation; and
real-browser tests using the actual component and installed virtualizer for
geometry. Preserve renderer, startup queue, PR-tail, expansion, and subagent
prepend contracts while changing the scroll implementation. Browser assertions
compare bottom gap or keyed element viewport coordinates, not mocked call
counts.

The implementation plan identifies exact files, task boundaries, browser
fixture/configuration, commands, and assertions. Delivery requires the
repository verification policy, updated stories, and documentation of the
durable scroll contract. This planning task does not implement the refactor.
