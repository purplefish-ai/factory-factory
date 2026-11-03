import {
  createContext,
  type FocusEvent,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

type FamilyWorkspace = {
  id: string;
  parentWorkspace?: { id: string } | null;
  childWorkspaceCount?: number;
};

/** Holds the highlighted family root outside React state so each card can
 * subscribe to its own highlighted boolean instead of the whole value. */
type RootStore = {
  get: () => string | null;
  set: (rootId: string | null) => void;
  subscribe: (listener: () => void) => () => void;
};

function createRootStore(): RootStore {
  let rootId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => rootId,
    set: (next) => {
      if (next === rootId) {
        return;
      }
      rootId = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The value is stable for the provider's lifetime. Workspace rows and the
// active root stay out of context so a snapshot update for one workspace does
// not re-render every memoized card on the board.
type HighlightContext = {
  rootStore: RootStore;
  setHovered: Dispatch<SetStateAction<string | null>>;
  setFocused: Dispatch<SetStateAction<string | null>>;
};
const FamilyContext = createContext<HighlightContext | null>(null);

const noopSubscribe = () => () => undefined;

export function KanbanFamilyProvider({
  workspaces,
  children,
}: {
  workspaces: readonly FamilyWorkspace[];
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [rootStore] = useState(createRootStore);
  const byId = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );
  useEffect(() => {
    if (hovered && !byId.has(hovered)) {
      setHovered(null);
    }
    if (focused && !byId.has(focused)) {
      setFocused(null);
    }
  }, [byId, hovered, focused]);
  const active = byId.get(hovered ?? '') ?? byId.get(focused ?? '');
  const hasFamily =
    active &&
    (active.parentWorkspace ||
      active.childWorkspaceCount ||
      workspaces.some((row) => row.parentWorkspace?.id === active.id));
  const rootId = hasFamily ? (active.parentWorkspace?.id ?? active.id) : null;
  useLayoutEffect(() => rootStore.set(rootId), [rootStore, rootId]);
  const value = useMemo(() => ({ rootStore, setHovered, setFocused }), [rootStore]);
  return <FamilyContext value={value}>{children}</FamilyContext>;
}

/** Cards remain usable outside a board, including standalone stories. */
export function useKanbanFamilyHighlight(workspace: FamilyWorkspace) {
  const workspaceId = workspace.id;
  const familyRootId = workspace.parentWorkspace?.id ?? workspace.id;
  const context = useContext(FamilyContext);
  const rootStore = context?.rootStore;
  const setHovered = context?.setHovered;
  const setFocused = context?.setFocused;
  const pointerFocus = useRef(false);
  // Selecting a boolean re-renders only cards whose highlight actually flips.
  const highlighted = useSyncExternalStore(
    rootStore?.subscribe ?? noopSubscribe,
    () => rootStore?.get() === familyRootId
  );
  useEffect(
    () => () => {
      setHovered?.((current) => (current === workspaceId ? null : current));
      setFocused?.((current) => (current === workspaceId ? null : current));
    },
    [workspaceId, setHovered, setFocused]
  );
  return {
    highlighted,
    onMouseEnter: () => setHovered?.(workspaceId),
    onMouseLeave: () => setHovered?.(null),
    onPointerDownCapture: () => {
      pointerFocus.current = true;
      setFocused?.(null);
    },
    onKeyDownCapture: () => {
      pointerFocus.current = false;
      setFocused?.(workspaceId);
    },
    onFocusCapture: (event: FocusEvent<HTMLElement>) => {
      if (!pointerFocus.current && event.target.matches(':focus-visible')) {
        setFocused?.(workspaceId);
      }
    },
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        pointerFocus.current = false;
        setFocused?.(null);
      }
    },
  };
}
