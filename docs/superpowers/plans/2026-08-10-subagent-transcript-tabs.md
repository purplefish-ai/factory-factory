# Sub-Agent Transcript Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sub-agent transcript drill-in navigation with persisted, closable workspace tabs whose robot icon reflects the sub-agent lifecycle.

**Architecture:** Extend the existing workspace panel state with a validated `subagent` tab and explicit open/update operations. Render sub-agent tabs and transcripts through the existing `MainViewTabBar` and `MainViewContent`, while the transcript query reports refreshed provider summaries back into the persisted tab snapshot. Keep `WorkspaceDetailView` responsible only for validating Agents-panel selections and closing the mobile sheet.

**Tech Stack:** React 19, TypeScript, Zod, TanStack Query through tRPC, Vitest with jsdom, Phosphor icons, Tailwind CSS.

## Global Constraints

- Sub-agent tabs persist with the existing workspace tabs and survive chat switches and application reloads.
- Tab identity is the pair of parent session ID and sub-agent ID; reopening that pair focuses and refreshes one tab.
- Different sub-agents, including equal child IDs under different parent sessions, may be open simultaneously.
- The tab displays a close button, a provider name or existing fallback name, and a status-colored `RobotIcon`.
- `starting` and `running` are blue and gently pulsing; `waiting` is amber; `completed` is green; `failed` is red; `cancelled` and `interrupted` are muted.
- Remove the Back button, breadcrumb, `Read only` pill, and status pill from the transcript content.
- Preserve existing loading, empty, pagination, invalidation, retry, unavailable, scroll, and read-only behavior.
- This is client-only: do not change ACP, tRPC, provider retention, or mutation controls.

---

### Task 1: Persisted sub-agent tab model

**Files:**
- Modify: `src/client/features/workspace/workspace-panel-context.tsx`
- Modify: `src/client/features/workspace/workspace-panel-context.test.tsx`

**Interfaces:**
- Consumes: `SubagentSelection` from `@/client/features/subagents` and `subagentSummarySchema` from `@/shared/acp-protocol`.
- Produces: `MainViewTab.type` includes `'subagent'`; `MainViewTab.subagentSelection?: SubagentSelection`; `openSubagentTab(selection: SubagentSelection): void`; `updateSubagentTab(selection: SubagentSelection): void` on `WorkspacePanelContextValue`.

- [ ] **Step 1: Write failing persistence and identity tests**

Extend the probe so tests exercise the real provider operations and rendered state:

```tsx
const runningSelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting auth',
    resultPreview: null,
  },
};

function WorkspacePanelActionsProbe() {
  const { activeTabId, tabs, openSubagentTab, updateSubagentTab, closeTab } =
    useWorkspacePanel();
  return (
    <>
      <button type="button" onClick={() => openSubagentTab(runningSelection)}>
        Open running
      </button>
      <button
        type="button"
        onClick={() =>
          openSubagentTab({
            ...runningSelection,
            parentSessionId: 'session-2',
            parentSessionName: 'Chat 2',
          })
        }
      >
        Open same child under another parent
      </button>
      <button
        type="button"
        onClick={() =>
          updateSubagentTab({
            ...runningSelection,
            subagent: {
              ...runningSelection.subagent,
              name: 'Completed security review',
              status: 'completed',
              completedAt: '2026-08-10T10:05:00.000Z',
            },
          })
        }
      >
        Complete
      </button>
      <button type="button" onClick={() => closeTab(activeTabId)}>
        Close active
      </button>
      <output>{JSON.stringify({ activeTabId, tabs })}</output>
    </>
  );
}
```

Add tests with hand-authored expectations:

```tsx
it('opens, deduplicates, refreshes, and closes a persisted sub-agent tab', async () => {
  const { container, root } = renderPanel(<WorkspacePanelActionsProbe />);

  clickButton(container, 'Open running');
  clickButton(container, 'Open running');
  await vi.waitFor(() => {
    const state = readProbe(container);
    expect(state.tabs.filter((tab) => tab.type === 'subagent')).toHaveLength(1);
    expect(state.activeTabId).toBe('subagent-session-1-child-1');
  });

  clickButton(container, 'Complete');
  await vi.waitFor(() => {
    const tab = readProbe(container).tabs.find((candidate) => candidate.type === 'subagent');
    expect(tab).toEqual(
      expect.objectContaining({
        id: 'subagent-session-1-child-1',
        label: 'Completed security review',
        subagentSelection: expect.objectContaining({
          subagent: expect.objectContaining({ status: 'completed' }),
        }),
      })
    );
    expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? '[]')).toContainEqual(tab);
  });

  clickButton(container, 'Close active');
  expect(readProbe(container).activeTabId).toBe('chat');
  expect(readProbe(container).tabs).toHaveLength(1);
  root.unmount();
});

it('keeps equal child IDs under different parent sessions distinct', async () => {
  const { container, root } = renderPanel(<WorkspacePanelActionsProbe />);
  clickButton(container, 'Open running');
  clickButton(container, 'Open same child under another parent');
  await vi.waitFor(() => {
    expect(readProbe(container).tabs.map((tab) => tab.id)).toEqual([
      'chat',
      'subagent-session-1-child-1',
      'subagent-session-2-child-1',
    ]);
  });
  root.unmount();
});

it('restores a valid persisted sub-agent tab and rejects an incomplete one', async () => {
  const validTab: MainViewTab = {
    id: 'subagent-session-1-child-1',
    type: 'subagent',
    label: 'Security review',
    subagentSelection: runningSelection,
  };
  localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify([{ id: 'chat', type: 'chat', label: 'Chat' }, validTab]));
  localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, validTab.id);
  const validRender = renderPanel(<WorkspacePanelProbe />);
  await vi.waitFor(() => expect(readProbe(validRender.container).activeTabId).toBe(validTab.id));
  validRender.root.unmount();

  localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify([
    { id: 'chat', type: 'chat', label: 'Chat' },
    { id: 'subagent-broken', type: 'subagent', label: 'Broken' },
  ]));
  const invalidRender = renderPanel(<WorkspacePanelProbe />);
  await vi.waitFor(() => expect(readProbe(invalidRender.container).tabs).toEqual([
    { id: 'chat', type: 'chat', label: 'Chat' },
  ]));
  invalidRender.root.unmount();
});
```

Keep `renderPanel`, `clickButton`, and `readProbe` as test-only helpers in `workspace-panel-context.test.tsx`; they must mount the real `WorkspacePanelProvider` and derive expectations from literal values rather than production helpers.

- [ ] **Step 2: Run the focused test and verify the new tests fail for missing sub-agent tab support**

Run:

```bash
pnpm test src/client/features/workspace/workspace-panel-context.test.tsx
```

Expected: FAIL because `openSubagentTab`, `updateSubagentTab`, the `subagent` enum member, and `subagentSelection` do not exist.

- [ ] **Step 3: Implement the minimal tab model and context operations**

Extend `MainViewTab` and the context value:

```ts
export interface MainViewTab {
  id: string;
  type: 'chat' | 'file' | 'diff' | 'screenshot' | 'closed-session' | 'subagent';
  path?: string;
  closedSessionId?: string;
  subagentSelection?: SubagentSelection;
  label: string;
}

interface WorkspacePanelContextValue extends WorkspacePanelState {
  openTab: (type: Exclude<MainViewTab['type'], 'subagent'>, path?: string, label?: string) => void;
  openSubagentTab: (selection: SubagentSelection) => void;
  updateSubagentTab: (selection: SubagentSelection) => void;
  // retain the existing members unchanged
}
```

Add the persisted schema field and require it for `subagent` tabs:

```ts
const SubagentSelectionSchema = z.object({
  parentSessionId: z.string().min(1),
  parentSessionName: z.string(),
  subagent: subagentSummarySchema,
});

// In MainViewTabSchema:
type: z.enum(['chat', 'file', 'diff', 'screenshot', 'closed-session', 'subagent']),
subagentSelection: SubagentSelectionSchema.optional(),

// In superRefine:
if (tab.type === 'subagent' && !tab.subagentSelection) {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Sub-agent tabs require a selection snapshot',
    path: ['subagentSelection'],
  });
}
```

Use the existing fallback naming rule and a deterministic pair-scoped ID:

```ts
function getSubagentTabLabel(selection: SubagentSelection): string {
  return selection.subagent.name?.trim() || `Sub-agent ${selection.subagent.id.slice(0, 8)}`;
}

function getSubagentTabId(selection: SubagentSelection): string {
  return `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
}

const openSubagentTab = useCallback((selection: SubagentSelection) => {
  const id = getSubagentTabId(selection);
  setTabs((current) => {
    const existing = current.some((tab) => tab.id === id && tab.type === 'subagent');
    const refreshed = current.map((tab) =>
      tab.id === id
        ? { ...tab, label: getSubagentTabLabel(selection), subagentSelection: selection }
        : tab
    );
    return existing
      ? refreshed
      : [
          ...current,
          {
            id,
            type: 'subagent',
            label: getSubagentTabLabel(selection),
            subagentSelection: selection,
          },
        ];
  });
  setActiveTabId(id);
}, []);

const updateSubagentTab = useCallback((selection: SubagentSelection) => {
  const id = getSubagentTabId(selection);
  setTabs((current) =>
    current.map((tab) =>
      tab.id === id && tab.type === 'subagent'
        ? { ...tab, label: getSubagentTabLabel(selection), subagentSelection: selection }
        : tab
    )
  );
}, []);
```

Include both callbacks in the memoized context value and dependency list. Preserve the existing `closeTab` neighboring-tab behavior and local-storage effects.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/client/features/workspace/workspace-panel-context.test.tsx
```

Expected: all workspace panel persistence and identity tests PASS.

- [ ] **Step 5: Commit the panel model**

```bash
git add src/client/features/workspace/workspace-panel-context.tsx src/client/features/workspace/workspace-panel-context.test.tsx
git commit -m "Add persisted sub-agent workspace tabs"
```

---

### Task 2: Headerless transcript and reusable live-summary hook

**Files:**
- Modify: `src/client/features/subagents/subagent-transcript-content.tsx`
- Modify: `src/client/features/subagents/subagent-transcript-view.tsx`
- Modify: `src/client/features/subagents/subagent-transcript-view.test.tsx`
- Modify: `src/client/features/subagents/subagent-transcript-content.test.tsx`
- Modify: `src/client/features/subagents/subagent-transcript-view.stories.tsx`
- Create: `src/client/features/subagents/use-live-subagent-selection.ts`
- Create: `src/client/features/subagents/use-live-subagent-selection.test.tsx`
- Modify: `src/client/features/subagents/index.ts`

**Interfaces:**
- Consumes: the existing `SubagentSelection`, transcript queries, and browser invalidation event.
- Produces: `useLiveSubagentSelection(selection: SubagentSelection): SubagentSelection` from the public subagents barrel; `SubagentTranscriptContentProps` no longer has `onBack`; the transcript root contains no navigation/status header; `SubagentTranscriptView` no longer duplicates the summary query.

- [ ] **Step 1: Write failing tests for the removed header and extracted summary behavior**

Replace the breadcrumb test with behavior that proves the transcript is still readable but has no duplicate navigation chrome:

```tsx
it('renders transcript content without breadcrumb, back action, or status pills', () => {
  render({
    kind: 'ready',
    messages: [message('message-1', 'Review complete', 0)],
    hasOlder: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
  });

  expect(container.textContent).toContain('Review complete');
  expect(container.textContent).not.toContain('Session 1');
  expect(container.textContent).not.toContain('Security review');
  expect(container.textContent).not.toContain('Read only');
  expect(container.textContent).not.toContain('Running');
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Back')).toBe(false);
  expect(document.querySelector('textarea')).toBeNull();
});
```

Update the unavailable-state test to retain the preview and Retry assertions but remove its old expectation that the `Failed` header pill is visible.

Move summary-refresh assertions out of `SubagentTranscriptView` and into a new
hook test that mounts a real probe while mocking only the tRPC boundary:

```tsx
function LiveSelectionProbe() {
  const current = useLiveSubagentSelection(selection());
  return <output>{JSON.stringify(current)}</output>;
}

it('returns the authoritative provider summary and refetches only matching invalidations', () => {
  const completed = {
    ...selection().subagent,
    name: 'Completed security review',
    status: 'completed' as const,
    completedAt: '2026-08-10T10:05:00.000Z',
  };
  mocks.listQueryResult.data = {
    supported: true,
    subagents: [completed],
    nextCursor: null,
  };
  renderHookProbe();
  expect(JSON.parse(container.textContent ?? '')).toEqual({
    ...selection(),
    subagent: completed,
  });

  void act(() => dispatchSubagentChange({
    sessionId: 'another-session',
    subagentId: 'child-1',
    change: 'completed',
  }));
  expect(mocks.listRefetch).not.toHaveBeenCalled();

  void act(() => dispatchSubagentChange({
    sessionId: 'session-1',
    subagentId: 'child-1',
    change: 'completed',
  }));
  expect(mocks.listRefetch).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run both focused suites and verify the tests fail against the existing header/back contract**

Run:

```bash
pnpm test src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx
```

Expected: FAIL because the old header remains, `onBack` is required, and the live-summary hook does not exist.

- [ ] **Step 3: Remove transcript navigation chrome and extract the summary observer**

Delete `TranscriptHeader`, `statusLabel`, and `statusClassName`; remove the unused `ArrowLeftIcon`, `CaretRightIcon`, `cn`, and header-only imports. Change the content contract and render to:

```tsx
export interface SubagentTranscriptContentProps {
  workspaceId: string;
  selection: SubagentSelection;
  state: SubagentTranscriptState;
  viewportRef?: RefObject<HTMLDivElement | null>;
}

export function SubagentTranscriptContent({
  workspaceId,
  selection,
  state,
  viewportRef,
}: SubagentTranscriptContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1">
        {/* retain the four existing state renderers unchanged */}
      </div>
    </div>
  );
}
```

Move the matching summary lookup into a new hook. It remains inside the
subagents feature, uses the same infinite-query shape as the Agents panel,
always refreshes restored tabs on mount, walks later pages until the child is
found or pagination is exhausted, and listens for matching browser
invalidations. It accepts only summaries proven at least as fresh as the stored
snapshot and never regresses a terminal status to a non-terminal one:

```ts
export function useLiveSubagentSelection(selection: SubagentSelection): SubagentSelection {
  const query = trpc.session.listSubagents.useInfiniteQuery(
    { sessionId: selection.parentSessionId, cursor: null, limit: 100 },
    {
      refetchOnMount: 'always',
      getNextPageParam: (lastPage) =>
        lastPage.supported ? (lastPage.nextCursor ?? undefined) : undefined,
    }
  );

  useEffect(() =>
    subscribeToSubagentChanges((detail) => {
      if (
        detail.sessionId === selection.parentSessionId &&
        detail.subagentId === selection.subagent.id
      ) {
        void query.refetch();
      }
    }),
    [query.refetch, selection.parentSessionId, selection.subagent.id]
  );

  const refreshed = query.data?.pages
    .filter((page) => page.supported)
    .flatMap((page) => page.subagents)
    .find((candidate) => candidate.id === selection.subagent.id);
  const loadedPageCount = query.data?.pages.length ?? 0;

  useEffect(() => {
    if (
      loadedPageCount === 0 ||
      refreshed ||
      !query.hasNextPage ||
      query.isFetching ||
      query.isFetchNextPageError
    ) {
      return;
    }
    void query.fetchNextPage();
  }, [
    loadedPageCount,
    query.fetchNextPage,
    query.hasNextPage,
    query.isFetchNextPageError,
    query.isFetching,
    refreshed,
  ]);

  return refreshed &&
    isProvenAtLeastAsFresh(
      selection.subagent,
      refreshed,
      query.isFetchedAfterMount && query.isSuccess
    )
    ? { ...selection, subagent: refreshed }
    : selection;
}
```

The omitted `TERMINAL_STATUSES`, timestamp-validation, and
`isProvenAtLeastAsFresh` helpers are the focused freshness policy implemented
alongside this hook; see the production file for their full definitions.

Export the hook from `src/client/features/subagents/index.ts`. Remove the summary
query and summary refetch from `SubagentTranscriptView`; keep its transcript
query and matching transcript invalidation. Pass only `workspaceId`, `selection`,
and `state` to `SubagentTranscriptContent`. Update every story and test invocation
to remove `onBack`.

- [ ] **Step 4: Run focused tests and verify they pass without regressing pagination or invalidation**

Run:

```bash
pnpm test src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/subagents/use-live-subagent-selection.test.tsx
```

Expected: all content states, pagination, cache, retry, transcript invalidation,
header-removal, and live-summary tests PASS.

- [ ] **Step 5: Commit the transcript contract**

```bash
git add src/client/features/subagents/subagent-transcript-content.tsx src/client/features/subagents/subagent-transcript-view.tsx src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/subagents/subagent-transcript-view.stories.tsx src/client/features/subagents/use-live-subagent-selection.ts src/client/features/subagents/use-live-subagent-selection.test.tsx src/client/features/subagents/index.ts
git commit -m "Simplify sub-agent transcript view"
```

---

### Task 3: Render status-colored sub-agent tabs and tab content

**Files:**
- Modify: `src/client/features/workspace/main-view-tab-bar.tsx`
- Create: `src/client/features/workspace/main-view-tab-bar.test.tsx`
- Create: `src/client/features/workspace/main-view-tab-bar.stories.tsx`
- Modify: `src/client/features/workspace/main-view-content.tsx`
- Create: `src/client/features/workspace/main-view-content.test.tsx`

**Interfaces:**
- Consumes: `MainViewTab.subagentSelection`, `updateSubagentTab(selection)`, `useLiveSubagentSelection(selection)`, `SubagentTranscriptView`, and the existing `TabButton` close behavior.
- Produces: closable sub-agent tabs with accessible status-labelled `RobotIcon`s that refresh even while inactive; active sub-agent content renders `SubagentTranscriptView`.

- [ ] **Step 1: Write failing tab-bar tests for close affordance and lifecycle colors**

Mount the real `WorkspacePanelProvider` and `MainViewTabBar`, seeding local storage with a sub-agent tab. Use a table of literal expected classes:

Mock only `trpc.session.listSubagents.useInfiniteQuery` in this test file. Back
it with `mocks.summary`, return one supported page containing
`mocks.summary`, and return stable `mocks.listRefetch` and pagination functions.
Reset `mocks.summary` in `beforeEach`; each table row then assigns a complete
matching summary with that row's literal status before rendering, so the real
`useLiveSubagentSelection` hook remains under test without order-dependent
fixture state.

```tsx
it.each([
  ['starting', 'text-blue-500', true],
  ['running', 'text-blue-500', true],
  ['waiting', 'text-amber-500', false],
  ['completed', 'text-green-500', false],
  ['failed', 'text-destructive', false],
  ['cancelled', 'text-muted-foreground', false],
  ['interrupted', 'text-muted-foreground', false],
] as const)('shows a %s robot for a sub-agent tab', async (status, color, pulses) => {
  seedSubagentTab({ ...runningSelection, subagent: { ...runningSelection.subagent, status } });
  const { container, root } = renderTabBar(`workspace-${status}`);

  await vi.waitFor(() => {
    const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.includes('Security review')
    );
    const robot = tab?.querySelector<SVGElement>(`svg[aria-label="${status} sub-agent"]`);
    expect(robot?.classList.contains(color)).toBe(true);
    expect(robot?.classList.contains('animate-pulse')).toBe(pulses);
    expect(tab?.querySelector('button[aria-label="Close Security review"]')).not.toBeNull();
  });

  root.unmount();
});
```

Use a workspace-specific storage key consistently in `seedSubagentTab` and `renderTabBar`; the helper must seed `activeTabId` to the deterministic sub-agent tab ID and render required `MainViewTabBar` props with literal empty sessions, `selectedProvider="CODEX"`, and `setSelectedProvider={vi.fn()}`.

Add one integration case where storage starts with `running`, the mocked
`listSubagents` response returns the same child as `completed`, and the test
waits for both the green icon and the persisted `completed` selection. This is
the regression test that catches an inactive tab failing to consume a provider
status update.

- [ ] **Step 2: Write a failing content integration test using the real transcript component**

Mock only the tRPC query boundary, keeping `MainViewContent`, `SubagentTranscriptView`, and `SubagentTranscriptContent` real. Return a loading transcript query and a non-loading summary query:

```tsx
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useInfiniteQuery: () => ({
          data: undefined,
          fetchNextPage: vi.fn(() => Promise.resolve()),
          hasNextPage: false,
          isFetching: false,
          isFetchNextPageError: false,
          isFetchedAfterMount: false,
          isSuccess: false,
          refetch: vi.fn(() => Promise.resolve()),
        }),
      },
      readSubagentTranscript: {
        useInfiniteQuery: () => ({
          data: undefined,
          error: null,
          isLoading: true,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          hasNextPage: false,
          fetchNextPage: vi.fn(() => Promise.resolve()),
          refetch: vi.fn(() => Promise.resolve()),
        }),
      },
    },
  },
}));

it('renders a persisted active sub-agent tab while keeping chat mounted and hidden', async () => {
  seedSubagentTab(runningSelection);
  const { container, root } = renderContent();

  await vi.waitFor(() => expect(container.textContent).toContain('Loading transcript…'));
  const chat = container.querySelector('[data-testid="chat-content"]');
  expect(chat).not.toBeNull();
  expect(chat?.parentElement?.classList.contains('hidden')).toBe(true);

  root.unmount();
});
```

- [ ] **Step 3: Run the new suites and verify they fail because sub-agent tabs are not rendered**

Run:

```bash
pnpm test src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-content.test.tsx
```

Expected: FAIL because `MainViewTabBar` has no robot status rendering and `MainViewContent` has no sub-agent branch.

- [ ] **Step 4: Implement robot status rendering in the existing file-like tab group**

Import `RobotIcon` and add the literal state mapping:

```ts
function getSubagentIconClass(status: SubagentSelection['subagent']['status']): string {
  switch (status) {
    case 'starting':
    case 'running':
      return 'text-blue-500 animate-pulse';
    case 'waiting':
      return 'text-amber-500';
    case 'completed':
      return 'text-green-500';
    case 'failed':
      return 'text-destructive';
    case 'cancelled':
    case 'interrupted':
      return 'text-muted-foreground';
  }
}
```

Branch inside `TabItem` so non-sub-agent tabs retain their current icons:

```tsx
const subagentStatus =
  tab.type === 'subagent' ? tab.subagentSelection?.subagent.status : undefined;
const icon = subagentStatus ? (
  <RobotIcon
    aria-label={`${subagentStatus} sub-agent`}
    className={cn('h-3.5 w-3.5 shrink-0', getSubagentIconClass(subagentStatus))}
  />
) : (
  <Icon className="h-3.5 w-3.5 shrink-0" />
);
```

Return `RobotIcon` from `getTabIcon('subagent')` as the type-safe fallback. Because sub-agent tabs are included in `nonChatTabs`, they automatically appear after the separator and use `closeTab` through the existing `TabItem` mapping.

Render sub-agent tabs through a dedicated component so calling the live-summary
hook follows React's hook rules. Pass the required selection as its own prop so
the hook is unconditional. When the hook returns a different provider summary,
persist that snapshot without creating an update loop:

```tsx
function SubagentTabItem({ selection, label, isActive, onSelect, onClose, onRefresh }: {
  selection: SubagentSelection;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRefresh: (selection: SubagentSelection) => void;
}) {
  const current = useLiveSubagentSelection(selection);

  useEffect(() => {
    if (current.subagent !== selection.subagent) {
      onRefresh(current);
    }
  }, [
    current.parentSessionId,
    current.parentSessionName,
    current.subagent,
    onRefresh,
    selection.subagent,
  ]);

  return (
    <TabButton
      icon={
        <RobotIcon
          aria-label={`${current.subagent.status} sub-agent`}
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            getSubagentIconClass(current.subagent.status)
          )}
        />
      }
      label={label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
      truncate
    />
  );
}
```

In the `nonChatTabs` mapping, render `SubagentTabItem` only when both
`tab.type === 'subagent'` and `tab.subagentSelection` are true; otherwise render
the existing `TabItem`. Pass `updateSubagentTab` from the panel context as
`onRefresh`.

- [ ] **Step 5: Render active sub-agent transcript content and persist refreshes**

Add the active content branch:

```tsx
const { tabs, activeTabId } = useWorkspacePanel();
const subagentSelection =
  activeTab?.type === 'subagent' ? activeTab.subagentSelection : undefined;

{subagentSelection && activeTabKey && (
  <SubagentTranscriptView
    key={activeTabKey}
    workspaceId={workspaceId}
    selection={subagentSelection}
  />
)}
```

`showChat` remains true only for a missing or `chat` tab, so the existing mounted chat wrapper becomes hidden for sub-agent tabs without custom scroll bookkeeping.

- [ ] **Step 6: Run the new suites and all directly affected workspace/sub-agent suites**

Run:

```bash
pnpm test src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-content.test.tsx src/client/features/workspace/workspace-panel-context.test.tsx src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/subagents/use-live-subagent-selection.test.tsx
```

Expected: all suites PASS with no React act warnings or console errors.

- [ ] **Step 7: Commit the tab UI and content branch**

Before committing, add `main-view-tab-bar.stories.tsx` with two visual states.
Its local `SubagentTabBarStory` component mounts `MainViewTabBar`, calls
`openSubagentTab(selection)` in an effect, and is wrapped by
`WorkspacePanelProvider`. Export `RunningSubagent` using a running selection and
`CompletedSubagent` using the same selection with `status: 'completed'`; both
stories use an empty sessions array and the required literal provider props.

```bash
git add src/client/features/workspace/main-view-tab-bar.tsx src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-tab-bar.stories.tsx src/client/features/workspace/main-view-content.tsx src/client/features/workspace/main-view-content.test.tsx
git commit -m "Render sub-agent transcript tabs"
```

---

### Task 4: Replace route-local drill-in with panel tab opening

**Files:**
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-view.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-view.test.tsx`

**Interfaces:**
- Consumes: `openSubagentTab(selection)` from `useWorkspacePanel` and `SubagentSelection` from the public subagents barrel.
- Produces: `SessionTabsProps.handleOpenSubagentTab(selection)`; Agents-panel selection opens or focuses a persisted tab while mobile still closes the right-panel sheet.

- [ ] **Step 1: Replace drill-in tests with failing tab-opening behavior**

Add `handleOpenSubagentTab: vi.fn()` to `createViewProps().sessionTabs`. Remove the `SubagentTranscriptView` feature mock and the tests for Back navigation, route-local scroll restoration, clearing on session change, and clearing on workspace change.

Replace them with:

```tsx
it('opens a sub-agent tab without replacing or selecting the parent chat', () => {
  const props = createViewProps(0);
  props.rightPanelVisible = true;
  const { container, root } = renderView(props);
  const parentChat = container.querySelector('[data-testid="parent-chat"]');

  void act(() => {
    container.querySelector<HTMLButtonElement>('[data-testid="open-subagent"]')?.click();
  });

  expect(props.sessionTabs.handleOpenSubagentTab).toHaveBeenCalledOnce();
  expect(props.sessionTabs.handleOpenSubagentTab).toHaveBeenCalledWith(
    expect.objectContaining({
      parentSessionId: 'session-1',
      parentSessionName: 'Session 1',
      subagent: expect.objectContaining({ id: 'child-1', name: 'Security review' }),
    })
  );
  expect(container.querySelector('[data-testid="parent-chat"]')).toBe(parentChat);
  expect(props.sessionTabs.handleSelectSession).not.toHaveBeenCalled();
  root.unmount();
});

it('ignores a sub-agent selection owned by another parent session', () => {
  const props = createViewProps(0);
  props.rightPanelVisible = true;
  const { root } = renderView(props);
  const onOpenSubagent = rightPanelMock.mock.calls.at(-1)?.[0].onOpenSubagent;

  void act(() => {
    onOpenSubagent?.({
      parentSessionId: 'session-2',
      parentSessionName: 'Named session',
      subagent: {
        id: 'foreign-child',
        name: 'Foreign review',
        status: 'running',
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        latestActivity: null,
        resultPreview: null,
      },
    });
  });

  expect(props.sessionTabs.handleOpenSubagentTab).not.toHaveBeenCalled();
  root.unmount();
});
```

Keep and update the mobile test so it asserts both `handleOpenSubagentTab` and `setRightPanelVisible(false)`.

- [ ] **Step 2: Run the route suite and verify it fails against drill-in behavior**

Run:

```bash
pnpm test src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
```

Expected: FAIL because `handleOpenSubagentTab` is not in the view contract and the view still owns drill-in rendering.

- [ ] **Step 3: Wire the panel operation through the container and simplify the view**

In the container, destructure and pass the new operation:

```ts
const {
  rightPanelVisible,
  setRightPanelVisible,
  activeTabId,
  clearScrollState,
  openTab,
  openSubagentTab,
} = useWorkspacePanel();

sessionTabs={{
  // retain existing fields
  handleOpenSubagentTab: openSubagentTab,
}}
```

In `WorkspaceDetailView`, add the typed field and replace the existing handler body:

```ts
interface SessionTabsProps {
  // retain existing fields
  handleOpenSubagentTab: (selection: SubagentSelection) => void;
}

const handleOpenSubagent = useCallback(
  (selection: SubagentSelection) => {
    if (
      !(selectedSessionName && sessionTabs.selectedDbSessionId) ||
      selection.parentSessionId !== sessionTabs.selectedDbSessionId
    ) {
      return;
    }
    sessionTabs.handleOpenSubagentTab({
      ...selection,
      parentSessionName: selectedSessionName,
    });
    if (isMobile) {
      setRightPanelVisible(false);
    }
  }, [
    isMobile,
    selectedSessionName,
    sessionTabs.handleOpenSubagentTab,
    sessionTabs.selectedDbSessionId,
    setRightPanelVisible,
  ]
);
```

Delete `subagentDrillIn`, `parentChatScrollTopRef`, `restoreParentScrollRef`, both scope/scroll effects, `handleBackFromSubagent`, the direct `SubagentTranscriptView` import, and the `cn` import. Restore the workspace content child to:

```tsx
<ChatContent {...chat} />
```

- [ ] **Step 4: Run the route and affected tab suites**

Run:

```bash
pnpm test src/client/routes/projects/workspaces/workspace-detail-view.test.tsx src/client/features/workspace/workspace-panel-context.test.tsx src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-content.test.tsx
```

Expected: all route opening, mobile sheet, panel persistence, tab icon, and content selection tests PASS.

- [ ] **Step 5: Commit the route integration**

```bash
git add src/client/routes/projects/workspaces/workspace-detail-container.tsx src/client/routes/projects/workspaces/workspace-detail-view.tsx src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
git commit -m "Open sub-agents in workspace tabs"
```

---

### Task 5: Full verification and visual QA

**Files:**
- Verify: all files changed in Tasks 1-4
- Reference: `docs/superpowers/specs/2026-08-10-subagent-transcript-tabs-design.md`

**Interfaces:**
- Consumes: the completed implementation and approved design.
- Produces: fresh automated and visual evidence that the implementation satisfies the design.

- [ ] **Step 1: Run the complete affected test set**

```bash
pnpm test src/client/features/workspace/workspace-panel-context.test.tsx src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-content.test.tsx src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/subagents/use-live-subagent-selection.test.tsx src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
```

Expected: all listed suites PASS with zero failures.

- [ ] **Step 2: Run repository guardrails**

```bash
pnpm typecheck
pnpm check
pnpm check:fix
git diff --check
```

Expected: every command exits 0. Inspect `git diff` after `check:fix` and include only formatting changes caused by the implementation.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: the full Vitest suite exits 0 with zero failed tests.

- [ ] **Step 4: Visually inspect the updated stories/application**

Start Storybook or the development app with the repository command appropriate to the available fixture data:

```bash
pnpm storybook
```

Verify at desktop and mobile widths:

- opening an active sub-agent creates one blue pulsing robot tab with a visible close affordance on hover/focus;
- opening a completed sub-agent creates a green robot tab;
- reopening the same sub-agent focuses one tab rather than duplicating it;
- switching chats, files, and sub-agent tabs preserves each tab;
- reloading restores the sub-agent tab and its last-known icon state;
- the transcript begins directly with its loading, empty, error, or message content and has no breadcrumb header;
- closing the active sub-agent selects the neighboring tab;
- selecting from the mobile Agents sheet opens the tab and closes the sheet.

Stop the development server after inspection.

- [ ] **Step 5: Commit any verification-driven formatting or story corrections**

If Step 2 or Step 4 produced necessary tracked corrections, commit only those exact files:

```bash
git add src/client/features/workspace/workspace-panel-context.tsx src/client/features/workspace/workspace-panel-context.test.tsx src/client/features/workspace/main-view-tab-bar.tsx src/client/features/workspace/main-view-tab-bar.test.tsx src/client/features/workspace/main-view-tab-bar.stories.tsx src/client/features/workspace/main-view-content.tsx src/client/features/workspace/main-view-content.test.tsx src/client/features/subagents/subagent-transcript-content.tsx src/client/features/subagents/subagent-transcript-view.tsx src/client/features/subagents/subagent-transcript-content.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx src/client/features/subagents/subagent-transcript-view.stories.tsx src/client/features/subagents/use-live-subagent-selection.ts src/client/features/subagents/use-live-subagent-selection.test.tsx src/client/features/subagents/index.ts src/client/routes/projects/workspaces/workspace-detail-container.tsx src/client/routes/projects/workspaces/workspace-detail-view.tsx src/client/routes/projects/workspaces/workspace-detail-view.test.tsx
git commit -m "Polish sub-agent transcript tabs"
```

If the worktree is already clean, do not create an empty commit.
