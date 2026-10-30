# Transcript Scroll Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for
> tracking. Implementation was authorized after planning review.

**Goal:** Make live transcript scrolling predictable across output bursts,
reader input, layout changes, hydration, and pane/session switches.

**Architecture:** A chat-owned `ChatTranscript` component is the sole scroll
surface. A small controller owns intent and lifecycle; its React adapter uses
the installed TanStack virtualizer for measured positioning and anchoring.
Workspace/quick-chat composition supplies identity and persistence capabilities.

**Tech Stack:** React 19, TypeScript, TanStack React Virtual 3.14.23 / locked
virtual core 3.19.8, Zod, Vitest, Storybook, Playwright.

**Spec:**
[Transcript scroll ownership](../specs/2026-10-30-transcript-scroll-design.md)

## Global constraints

- Use Node 26.12.1 and pnpm 12.15.0; never npm or yarn.
- No new dependency or virtualizer upgrade. Read client feature guidance before
  editing; cross-feature imports use public barrels, and chat does not import
  workspace. Do not generalize this into a controller for diffs or terminals.
- Follow the behavior contract in the spec, including 24px user return
  threshold, 1px comparison epsilon, instant positioning, and the 12-attempt
  restore budget.
- Preserve message grouping, queued-message visibility during startup, tool
  expansion identity, permission/question behavior, PR-tail placement, and
  existing static closed-session behavior.
- Maintain existing storage keys and v1 compatibility; validate boundaries with
  Zod. No `process.env` access in new application code.
- Every implementation task adds failing behavior tests, verifies their failure,
  implements, verifies success, and makes a focused commit. Do not claim the
  engine contract from mocked virtualizer tests alone.

## Review focus

- Several output/measurement updates before a paint must retain following.
- Actual upward input before a pending command must win, including touch,
  keyboard and scrollbar input; ordinary clicks must not detach following.
- Hidden/hydrating panes and stale callbacks must not overwrite saved intent or
  another session/workspace's position.
- Images, wrapping, giant tool groups, footer-only updates and composer changes
  must preserve either bottom attachment or a keyed reading anchor.
- Rewind/trimming, empty/startup transitions and corrupt/legacy storage need
  deterministic fallback behavior without erasing valid records.

## File responsibilities and interfaces

Create under `src/client/features/chat/`:

- `chat-transcript.tsx`: public viewport, jump control and keyed instance
  boundary.
- `transcript-scroll.types.ts`: serializable position and surface options.
- `transcript-scroll-controller.ts`: intent/lifecycle/cancellation/restore
  policy.
- `transcript-scroll-position.ts`: keyed anchor capture/resolve using engine
  API.
- `use-transcript-scroll.ts`: DOM/React/virtualizer adapter, input and resize
  wiring.
- `transcript-layout.tsx`: measured header, final-row tail and status-only
  layout.
- Co-located controller, position, adapter and transcript tests; interactive
  `chat-transcript.stories.tsx`.

Retain `virtualized-message-list.tsx` as a private row renderer, extracting its
tail rendering into `transcript-layout.tsx` and deleting its scroll ownership.
Export only `ChatTranscript` and its required public types from `chat/index.ts`.

Public contracts (the named display props are the existing renderer data props,
excluding `scrollContainerRef`, `messagesEndRef`, `onScroll`, `isNearBottom`,
and `preserveScrollAnchorOnPrepend`):

```ts
type TranscriptIntent = 'following' | 'reading';
interface TranscriptPosition {
  intent: TranscriptIntent;
  top: number;
  left: number;
  anchor?: { key: string; offset: number };
}
interface TranscriptScrollOptions {
  identity: string;
  active: boolean;
  ready: boolean; // transcript hydration AND persistence snapshot are ready
  initialIntent: TranscriptIntent;
  initialPosition: TranscriptPosition | null;
  onPositionChange?: (position: TranscriptPosition) => void;
}
interface ChatTranscriptProps extends TranscriptDisplayProps {
  scroll: TranscriptScrollOptions;
  header?: React.ReactNode;
  label?: string;
}
```

`initialPosition` is sampled on identity/activation, not reapplied on each
callback-driven rerender. Position emissions are committed snapshots scoped to
the instance identity. Consumers do not supply a scroll ref or proximity state.

Controller port signatures, defined in Task 2 and used by Task 3:

```ts
interface TranscriptScrollPort {
  cancelPositioning(): void;
  scrollToEnd(): void;
  capturePosition(intent: TranscriptIntent): TranscriptPosition;
  restorePosition(position: TranscriptPosition): { measured: boolean; reached: boolean };
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}
createTranscriptScrollController(options: {
  initialIntent: TranscriptIntent;
  port: TranscriptScrollPort;
  onChange: (state: { intent: TranscriptIntent; phase: 'suspended' | 'restoring' | 'ready' }) => void;
  onPositionChange: (position: TranscriptPosition) => void;
}): {
  activate(position: TranscriptPosition | null): void;
  suspend(): void;
  layoutChanged(): void;
  measurementReady(): void;
  structureChanged(anchor: TranscriptPosition): void;
  beginInteraction(direction: 'up' | 'down' | 'unknown'): void;
  endInteraction(): void;
  userTakeover(): void;
  userScrolled(direction: 'up' | 'down', distanceFromEnd: number): void;
  jumpToLatest(): void;
  dispose(): void;
};
```

No new public framework is needed beyond these feature-local contracts.

`beginInteraction` cancels app/native commands and inhibits new app positioning
without discarding intent/restore targets; only directional upward input or
actual movement invokes takeover. `endInteraction` resumes retained intent or an
unconsumed target. `structureChanged` receives the last committed live reading
anchor before a prepend/trim/reorder affecting its preceding rows; it never
reads `initialPosition`. Invalidation observes actual changes to total size,
viewport dimensions or structural keys, not scroll-only engine notifications.
Skip end commands if already within 1px. Emit deduplicated committed snapshots
after user movement, intent changes, measured restore completion and settled
anchor-preserving geometry changes. `measurementReady()` wakes only a pending
unmeasured restore target, including one stalled after its frame budget; it is
separate from follow-layout invalidation. The adapter deduplicates readiness by
key/node/width-layout generation. Adapter-owned staged command state and write
provenance live behind the port; command cancellation resets their generation.

## Task 1: Establish real-engine behavior and a browser fixture

**Files:** Create `playwright.scroll.config.ts`,
`e2e/transcript-scroll.spec.ts`,
`src/client/routes/transcript-scroll-fixture.tsx`; modify
`src/client/router.tsx`, `package.json`, and `docs/chat-message-flow.md`.

**Interfaces:** Produces `pnpm test:e2e:scroll` and development-only route
`/__transcript-scroll`. The fixture initially hosts the existing renderer, then
switches to `ChatTranscript` in Task 3. It imports real application components
and the actual installed virtualizer, with deterministic messages and controls.

- [x] Add an explicit Playwright config restricted to
      `transcript-scroll.spec.ts`, frontend-only Vite server, Chromium desktop
      and mobile-sized Chromium projects, traces on failure, and no snapshot
      dependence. Use the existing development route gating pattern; never
      expose fixture controls in a production build. Add script
      `test:e2e:scroll` invoking that config. Avoid environment policy changes;
      use the existing development-mode route gate.
- [x] Provide controls for batched appends, a growing tool sequence without
      row-count increase, delayed image sizing, status-only changes, viewport
      width and height, hide/show, hydration, prepend, rewind, and A/B identity
      switching. Render controls outside the scroll surface and expose stable
      accessible labels.
- [x] Add a minimal direct-engine case in that fixture proving end anchoring,
      same-key last-row growth, `followOnAppend`, `scrollToEnd`, and
      `cancelScroll`. Characterize native end-pinning in reading near/clamped to
      the bottom and cancellation during delayed measurement. Then prove the
      selected configuration: always `anchorTo: 'start'`,
      `followOnAppend: false`, controller end commands, explicit keyed
      structural correction, and the fully-above resize predicate. Include
      backward-scroll followed by an above-viewport late resize, first
      measurement of a giant visible row, and engine compensation after
      cancellation. Run `pnpm test:e2e:scroll`; verify those engine cases pass
      before choosing adapter details. If an installed engine contract fails,
      narrow the adapter solution and revise this plan; do not silently add a
      competing scroll loop or upgrade.
- [x] Add product regression assertions: after a burst the bottom gap is <=1px;
      after upward takeover the keyed visible row remains within 1px once queued
      layout settles; a same-group tool burst follows. Confirm current behavior
      fails for the reproduced race(s), preserving traces. Product regressions
      may remain red until Task 3; commit them with explicit expected-failure
      annotations that Task 3 must remove. Direct-engine contract cases stay
      passing.
- [x] Document the fixture command and commit
      `test: capture transcript scroll races`.

## Task 2: Implement intent, lifecycle and keyed-position policy

**Files:** Create `transcript-scroll.types.ts`,
`transcript-scroll-controller.ts`, `transcript-scroll-position.ts` and their
co-located tests under the chat feature.

**Interfaces:** Consumes the confirmed engine contract from Task 1. Produces the
controller/port and position types above. Position helper signatures:
`captureTranscriptPosition(viewport, virtualizer, intent): TranscriptPosition`
and
`restoreTranscriptPosition(viewport, virtualizer, position): { measured: boolean; reached: boolean }`,
using typed TanStack instances.

- [x] Write deterministic tests using a fake frame queue and port. Assert that
      `layoutChanged()` never changes intent; many invalidations leave at most
      one pending app frame; upward takeover cancels frames/native commands;
      downward movement within 24px resumes; ordinary layout or clamping cannot
      resume.
- [x] Test activation into following/reading, suspension with queued work,
      disposal, user takeover during restore, and delayed callbacks after
      disposal. No position emissions while suspended or restoring. Test two
      measured frames within 1px to settle, a 12-attempt stall that cancels the
      native command without persistence, and resumption only after a fresh
      measurement notification. Test touchstart before a queued frame: no writes
      and unchanged intent; touchend without motion resumes following/restore;
      upward motion cancels the retained restore. During the interaction, fresh
      output must not bypass inhibition. A zero delta is not user movement.
      Duplicate geometry notifications while already at end must not keep
      scheduling app frames or commands.
- [x] Test anchor resolution by stable key after prepend and remeasurement,
      vanished-key pixel fallback, signed gap offsets and oversized offsets
      clamped to real bounds, and initial reading/following positions when no
      saved state exists. Test a row taller than the viewport and retained
      row-relative reading offset. Define staged restore: resolve key, issue one
      mount-index command, await its measurement, cancel that command, then
      issue/refine offset commands only when measured target changes. Assert
      there is never a competing index and offset target, and the 12-attempt
      stall cancels native reconciliation. Structural reading corrections use
      the live committed anchor and current input epoch, never restart
      identity/activation restore from persisted state.
- [x] Run
      `pnpm test src/client/features/chat/transcript-scroll-controller.test.ts src/client/features/chat/transcript-scroll-position.test.ts`;
      verify the new assertions fail before implementing the declared functions,
      then pass.
- [x] Implement one generation-scoped app frame, explicit restore state and
      snapshots. Use native scroll commands and measured keyed rows; do not
      reconstruct previous bottom proximity by subtracting resize deltas. Commit
      `refactor: model transcript scroll intent and restoration`.

## Task 3: Build the shared transcript surface and engine adapter

**Files:** Create `chat-transcript.tsx`, `use-transcript-scroll.ts`,
`transcript-layout.tsx`, co-located tests and `chat-transcript.stories.tsx`;
modify `virtualized-message-list.tsx`, its test/story family, the browser
fixture, and `chat/index.ts`. Keep the old exported wrapper temporarily for
consumers until Task 5; it must not be used inside the new component.

**Interfaces:** Consumes Task 2 contracts. Produces `ChatTranscript` and
`TranscriptPosition` via the chat barrel, using `ChatTranscriptProps` above.
Private renderer receives the virtualizer and display model; it owns no
listeners, proximity refs, restore effects or scroll commands.

- [x] Add adapter tests for actual viewport-node attachment, StrictMode
      mount/cleanup/remount, visibility/readiness changes, viewport replacement,
      and cancellation of old-identity frames. Register listeners before
      positioning; remove every listener, observer and frame on cleanup.
- [x] Distinguish native/user movement from programmatic scroll events by
      wrapping public `scrollToFn`: delegate each write to `elementScroll`,
      record its actual clamped top/left and identity/input generation, and
      recognize delayed/coalesced read-backs. Track browser clamping caused by
      geometry separately. Neither `isTrusted` nor a one-frame boolean is
      sufficient. Do not reject native adjustment writes while the engine
      advances its logical offset. `cancelScroll()` cancels end/restore targets;
      legitimate native above-anchor compensation can continue.
- [x] Wire input episodes through `beginInteraction`/`endInteraction`. Upward
      wheel/scroll keys cancel and establish reading before native movement.
      Touch start or scrollbar pointerdown cancels/inhibits without changing
      intent; actual movement changes it. Ignore editable targets/modified
      shortcuts and ordinary content clicks. Finish touch/pointer episodes on
      end/cancel; finish wheel/key episodes on native scrollend or engine idle.
      Start/refresh an adapter-owned 150ms fallback from input itself and
      ongoing scroll activity, so wheel/End at the bottom cannot leave
      inhibition stuck without a scroll event. Test that boundary case with a
      subsequent append. Explicit jump ends inhibition. Test a stationary tap,
      delayed scroll delivery, repeat keys, scrollbar drag, composer typing and
      tool expansion.
- [x] Configure stable keys, `anchorTo: 'start'` and `followOnAppend: false` in
      both intent modes. Controller invalidations from measured content size,
      structural keys and viewport dimensions schedule end positioning only
      while following/ready and not interacting. Publish invalidation after the
      matching React sizer commit, or retain its dirty generation until that
      committed extent is evaluated. Stale zero-gap DOM cannot consume growth.
      Suspend engine activity while hidden or hydrating. Scroll-only
      notifications must not restart positioning. Set public
      `shouldAdjustScrollPositionOnItemSizeChange` on the instance to compensate
      fully-above rows (`item.end <= (instance.scrollOffset ?? 0) + 1`),
      including after backward scrolling, and avoid growth inside the visible
      row. Prove first-measurement and giant-row behavior against the real
      engine. Wrap the public measurement option while delegating native sizing;
      maintain key/node/width-generation validity even when measured height
      equals the estimate. Notify `measurementReady()` on a newly valid restore
      target, not every callback. Test zero-delta target measurement after a
      12-frame stall, old-width/replaced-node invalidation, and delayed sizer
      commits.
- [x] Compare committed structural keys and use the last committed live reading
      anchor before prepend/trim/reorder affecting preceding rows. Ask the
      controller for staged keyed correction, scoped to its input/identity
      generation. Pure appends and same-key growth never restart saved-position
      restoration. Do not update the cached anchor from transitional DOM before
      correction settles. Remove separate message-count/reasoning pin effects;
      native positioning and this one controller replace them.
- [x] Implement measured leading header, final-row tail and status-only row.
      Ensure tail moves between rows without remounting existing message
      renderers; preserve PR queue filtering and startup loading output. Test
      footer-only growth, tail removal/shrinkage, header-size changes and
      empty-to-first-message transitions. Keep the tail in the same measured
      extent; native append detection is disabled.
- [x] Render an overlay jump button inside a relative viewport wrapper,
      accessible by its existing label. Compare `clientHeight` before/after the
      button appears; it must be unchanged. Give the controlled viewport
      `overflow-anchor: none`.
- [x] Switch the browser fixture to the real `ChatTranscript`. Remove expected
      failure annotations; run the focused new Vitest tests and
      `pnpm test:e2e:scroll`. Require passing burst, same-key growth,
      user-interruption, image-size, footer-only, resize, hide/show and prepend
      cases. Add following, reading, hydration and rapid-tool-output stories;
      inspect them in Storybook.
- [x] Commit `refactor: give chat transcripts one scroll owner`.

## Task 4: Persist intent and anchors without changing other viewers

**Files:** Modify `workspace/scroll-state.ts`, `scroll-state.test.ts`,
`workspace-panel-context.tsx` and its tests; create
`workspace/use-chat-transcript-persistence.ts` and its tests; export the hook
from `workspace/index.ts` if composition needs it.

**Interfaces:** Consumes public `TranscriptPosition`. Extends `ScrollState` with
`chatPosition?: TranscriptPosition`, Zod-validated without importing chat
internals. The hook consumes workspace/session identity and returns
`{ ready: boolean; initialPosition: TranscriptPosition | null; onPositionChange: (position: TranscriptPosition) => void; clearSession: (sessionId: string) => void }`.
It adapts `chat-<session>:chat` entries and has no DOM access.

- [x] Add storage tests for following/reading round trips, malformed optional
      anchors, nonfinite offsets, valid signed chat offsets, legacy
      true/false/missing `stickToBottom`, unknown fields and unsupported
      versions. Existing valid code/markdown/diff records and their
      serialization must remain compatible.
- [x] Add provider/hook tests for delayed storage readiness, A/B session
      changes, A/B workspace changes with a pending debounce, stale A callbacks
      after B loads, final flush on unmount, storage exceptions and
      close-session clearing. Assert exact storage keys and that no A snapshot
      reaches B's record. `clearSession(sessionId)` revokes that session's
      persistence generation before deletion; invoking an old callback
      immediately after clear or after cleanup must not recreate the entry.
      Close inactive B while A remains selected: revoke/remove B only, and
      reject a late B callback. Quick-chat map clearing also uses the actual
      closed session ID.
- [x] Expose workspace-scoped loaded identity as reactive state. Guard saved
      callbacks with the captured workspace/session; flush old workspace pending
      snapshots before replacing its record. Main callbacks use committed
      snapshots, never a shared viewport sampled after identity changed.
- [x] Prefer valid `chatPosition`; otherwise adapt legacy pixels/intent per the
      spec. Keep the storage envelope version 1 with optional new fields; do not
      rewrite unrelated viewer entries. Preserve valid pixels when an anchor is
      bad.
- [x] Run the new storage/provider/hook tests and existing diff/file viewer
      tests. Commit `refactor: persist transcript intent and keyed anchors`.

## Task 5: Migrate every live renderer consumer and remove duplicate owners

**Files:** Modify route `workspace-detail-container.tsx`,
`workspace-detail-chat-content.tsx`, their tests/stories;
`kanban/use-quick-chat.ts`, `quick-chat-content.tsx`, `quick-chat-sheet.tsx` and
their tests/stories; `subagents/subagent-transcript-content.tsx` and its tests;
`workspace/right-panel.stories.tsx`; PR-renderer stories and all remaining
message-list fixtures. Modify `chat/index.ts`. Delete
`src/hooks/use-auto-scroll.ts` once no consumers remain.

**Interfaces:** All consumers use `ChatTranscript` through the chat barrel. Main
supplies Task 4 persistence plus workspace/session/main identity. Quick chat
supplies workspace/session/quick identity and a parent-lifetime Map of committed
positions. Subagent supplies parent-session/subagent identity and
`initialIntent: 'reading'`, retaining prepend behavior. PR review extends the
workspace persistence adapter to subagent tab IDs, restoring positions across
pane unmounts without introducing a cross-feature dependency cycle.

- [x] Add composition tests that assert correct active/ready/identity/options
      across file/diff/subagent pane selection, session replacement, hydration,
      quick-sheet close/reopen and workspace switching. Use the actual
      `showChat` visibility predicate, including fallback to chat when no active
      tab is found. Main readiness is
      `selectedSessionId != null && runtimeSessionId === selectedSessionId && scrollLoadedWorkspaceId === workspaceId`.
      Quick readiness requires non-null workspace/session and the matching
      `runtimeSessionId` without storage readiness; subagent readiness is
      `state.kind === 'ready'` plus workspace storage readiness. Thread the
      existing public hydration marker through composition; runtime phase alone
      is not readiness. Add selection-before-passive-effect,
      timeout-before-hydration, disconnect-before-hydration and
      early-runtime-event tests. Modal occlusion of main chat on mobile does not
      itself mean its viewport is hidden.
- [x] Move viewport/jump ownership into `ChatTranscript`; pass main banners and
      subagent history/error controls as measured headers. Remove caller
      `isNearBottom`, `onScroll`, scroll refs and composer-height scroll writes.
      Viewport resize observation replaces composer callbacks used solely for
      scrolling.
- [x] Delete main chat's `usePersistentScroll` invocation, raw-message restore
      dependencies, previous-session DOM sampling, and every legacy message-list
      append/reasoning/resize pin. Keep `usePersistentScroll` for file/markdown
      viewers.
- [x] Migrate quick chat without introducing durable storage. Its session map
      survives content unmount while the sheet owner stays mounted; a new owner
      starts fresh. Clear/revoke its map entry on session close. Preserve
      subagent history pagination and initial reading behavior. Remove the old
      public message-list wrapper after the last consumer migrates.
- [x] Remove the unused end-marker ref from `use-chat-state.ts`,
      `use-chat-websocket.ts`, route view models and affected tests/stories if
      the repository-wide search still confirms no non-scroll use. Keep
      unrelated log end markers unchanged. Audit barrel consumers with `rg` and
      `pnpm deps:check`.
- [x] Run focused route/kanban/subagent/message-renderer suites, inspect main
      and quick-chat stories, update the existing composer-height-change story
      and `e2e/scroll-button-occlusion.spec.ts` locators for the new viewport
      owner while retaining its reachability/attachment/prompt assertions, then
      run `pnpm test:e2e:scroll` and
      `pnpm exec playwright test --config=playwright.chat.config.ts`. Commit
      `refactor: migrate live chat panes to transcript scroll ownership`.

## Task 6: Prove lifecycle behavior and complete delivery

**Files:** Expand `e2e/transcript-scroll.spec.ts` and the real-component
fixture; update `docs/chat-message-flow.md` with the implemented durable
contract and browser command. Adjust stories/tests only where behavior
intentionally changed.

**Interfaces:** Exercises the complete implementation from Tasks 1–5, including
real persistence adapters through a fixture provider, not a duplicate
simulation.

- [x] Assert following remains <=1px from the bottom after a 100-update burst, a
      100-call same-group burst, late image growth and footer-only changes. Test
      both tall/short messages and growth/shrinkage at desktop/mobile widths.
- [x] Assert wheel, keyboard, scrollbar and touch takeover prevents later
      correction, while tool expansion, text selection and composer typing
      preserve following. Use browser input APIs where available, with
      deterministic adapter tests for event types a desktop browser cannot
      authentically reproduce.
- [x] Record keyed row coordinates while reading; prepend/remeasure/wrap/resize,
      then assert preserved offset within 1px after settling. Separately test
      the declared row-relative limitation for edits inside a huge grouped row.
- [x] Hide a following pane, append output, then show it: latest output is
      visible. Repeat while reading: the saved key/offset is restored. Rapid
      A/B/A sessions and workspaces with delayed hydration cannot leak position
      or follow intent. Test hidden/zero-size activation, unmount with pending
      work, rewind deleting the saved key, reload of legacy/new storage, storage
      failure and queued startup.
- [x] Check jump-button appearance does not alter viewport height; explicit jump
      attaches through subsequent measurements. Observe scroll
      writes/coordinates in the fixture per animation frame to detect
      alternating corrections, rather than asserting only the eventual final
      offset. No hardcoded settling sleeps.
- [x] Run the repository-required commands in order: `pnpm check:fix`,
      `pnpm typecheck`, `pnpm test`, `pnpm check`; inspect formatter changes and
      remove unrelated edits. Also run `pnpm test:e2e:scroll`,
      `pnpm test:e2e:mobile`,
      `pnpm exec playwright test --config=playwright.chat.config.ts`, and
      inspect changed states in `pnpm storybook`. No blanket assertion weakening
      or guardrail changes to make the refactor pass.
- [x] Check `rg` finds no old scroll owner in live consumers, validate
      documented links/scripts, inspect the final diff, and commit
      `test: verify transcript scroll lifecycle in the browser`. Report
      commands, failures/unavailable checks, and residual platform limitations
      at handoff.

## Execution notes and review gate

Execute 1 → 2 → 3 → 4 → 5 → 6. Task 4 can be developed after Task 2 if interface
types are fixed, but do not integrate consumers until both engine and storage
contracts pass. Do not mix a partial migration into a shipping state. Each task
gets an independent code review during execution; the last gate reviews the
whole scroll lifecycle, not just file-by-file changes.

Planning review completed in three rounds across engine/UX races,
storage/lifecycle integration, and implementability/test coverage. All three
reviewers reported no remaining HIGH or MEDIUM concerns in the final round; see
the [review record](./2026-10-30-transcript-scroll-review.md). Implementation
was subsequently authorized and completed. Whole-branch review and local
verification are complete; results and limitations are recorded below.

Execution decisions: Tasks 3–5 are delivered together so the public API
migration is coherent. Renderer content/queue/history assertions remain in the
renamed `transcript-rows` suites; controller/event/browser tests replace
effect-call-count assertions. Browser restores assert keyed viewport coordinates
across remounts, because offscreen size estimates can legitimately change
absolute pixels. The viewport reserves 48px consistently so expanded prompts
cannot occlude the jump overlay. Browser suites use separate output directories;
cold Storybook graph compilation is warmed before the timed composer interaction
cases.

Final verification after PR review: `pnpm check:fix`, `pnpm typecheck` and
`pnpm check` passed. The full Vitest run passed 9,239 tests with 3 skipped and
no failures. The combined focused review suites passed 69 tests. Browser suites
passed 36 transcript, 4 Storybook (composer and subagent restoration/width), and
30 existing mobile cases. Mobile, desktop and wide subagent Storybook
screenshots were inspected. The header remains measured offscreen;
frame-scheduled resize batches avoid a reproduced ResizeObserver delivery loop.

PR review follow-up restores workspace-owned subagent positions across pane
unmounts and retains the prior content width. Node-keyed weak measurements
release detached rows. Failed quick-chat deletion preserves scroll memory while
revoking stale callbacks; success clears the originating workspace's record.
Additional test fixes cover delayed scroll stability, user movement after native
writes, hydration filtering, identity boundaries, deterministic cleanup,
nonfinite stored anchors, and unique keys for repeated fixture actions.

The final review's gap-position defect was fixed with signed anchors and
storage/browser regressions. Direct keyboard and scrollbar tests cover the
review's smaller coverage concern. Physical iOS/Safari momentum remains a
hardware validation limitation; the synthetic iOS engine branch only proves the
installed dependency's deferred-write contract. Native end-mode engine
characterization logs its existing ResizeObserver warning; the application uses
start mode and its header-resize test asserts no window/page errors. Anchoring
within a giant tool group remains relative to the grouped row.
