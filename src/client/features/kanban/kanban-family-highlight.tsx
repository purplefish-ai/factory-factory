import {
  createContext,
  type FocusEvent,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useEffect,
} from 'react';

type FamilyWorkspace = {
  id: string;
  parentWorkspace?: { id: string } | null;
  childWorkspaceCount?: number;
};
type HighlightContext = {
  rootId: string | null;
  workspaces: ReadonlyMap<string, FamilyWorkspace>;
  setHovered: (id: string | null) => void;
  setFocused: (id: string | null) => void;
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
  return (
    <FamilyContext value={{ rootId, workspaces: byId, setHovered, setFocused }}>
      {children}
    </FamilyContext>
  );
}

/** Cards remain usable outside a board, including standalone stories. */
export function useKanbanFamilyHighlight(workspaceId: string) {
  const context = useContext(FamilyContext);
  const workspace = context?.workspaces.get(workspaceId);
  return {
    highlighted: Boolean(
      context?.rootId &&
      workspace &&
      (workspace.parentWorkspace?.id ?? workspace.id) === context.rootId
    ),
    onMouseEnter: () => context?.setHovered(workspaceId),
    onMouseLeave: () => context?.setHovered(null),
    onFocusCapture: () => context?.setFocused(workspaceId),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        context?.setFocused(null);
      }
    },
  };
}
