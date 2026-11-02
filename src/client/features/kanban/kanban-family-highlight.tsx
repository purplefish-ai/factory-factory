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
  useRef,
} from 'react';

type FamilyWorkspace = {
  id: string;
  parentWorkspace?: { id: string } | null;
  childWorkspaceCount?: number;
};
type HighlightContext = {
  rootId: string | null;
  workspaces: ReadonlyMap<string, FamilyWorkspace>;
  setHovered: Dispatch<SetStateAction<string | null>>;
  setFocused: Dispatch<SetStateAction<string | null>>;
};
const FamilyContext = createContext<HighlightContext | null>(null);

export function KanbanFamilyProvider({
  workspaces,
  children,
}: {
  workspaces: readonly FamilyWorkspace[];
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
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
  const value = useMemo(
    () => ({ rootId, workspaces: byId, setHovered, setFocused }),
    [rootId, byId]
  );
  return <FamilyContext value={value}>{children}</FamilyContext>;
}

/** Cards remain usable outside a board, including standalone stories. */
export function useKanbanFamilyHighlight(workspaceId: string) {
  const context = useContext(FamilyContext);
  const workspace = context?.workspaces.get(workspaceId);
  const setHovered = context?.setHovered;
  const setFocused = context?.setFocused;
  const pointerFocus = useRef(false);
  useEffect(
    () => () => {
      setHovered?.((current) => (current === workspaceId ? null : current));
      setFocused?.((current) => (current === workspaceId ? null : current));
    },
    [workspaceId, setHovered, setFocused]
  );
  return {
    highlighted: Boolean(
      context?.rootId &&
      workspace &&
      (workspace.parentWorkspace?.id ?? workspace.id) === context.rootId
    ),
    onMouseEnter: () => context?.setHovered(workspaceId),
    onMouseLeave: () => context?.setHovered(null),
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
        context?.setFocused(null);
      }
    },
  };
}
