import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

interface AppHeaderContextValue {
  title: ReactNode;
  setTitle: (title: ReactNode) => void;
  /** Portal target element for right-side header content */
  rightSlot: HTMLElement | null;
  setRightSlot: (el: HTMLElement | null) => void;
  /** Portal target element for left-side extra content (e.g. info chips) */
  leftExtraSlot: HTMLElement | null;
  setLeftExtraSlot: (el: HTMLElement | null) => void;
}

const AppHeaderContext = createContext<AppHeaderContextValue | null>(null);

export function AppHeaderProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<ReactNode>('');
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null);
  const [leftExtraSlot, setLeftExtraSlot] = useState<HTMLElement | null>(null);

  const value = useMemo(
    () => ({ title, setTitle, rightSlot, setRightSlot, leftExtraSlot, setLeftExtraSlot }),
    [title, rightSlot, leftExtraSlot]
  );

  return <AppHeaderContext.Provider value={value}>{children}</AppHeaderContext.Provider>;
}

export function useAppHeaderContext(): AppHeaderContextValue {
  const ctx = useContext(AppHeaderContext);
  if (!ctx) {
    throw new Error('useAppHeaderContext must be used within an AppHeaderProvider');
  }
  return ctx;
}

/**
 * Convenience hook for route components to set the header title.
 * Returns portal target elements for rightContent and leftExtra
 * so routes can use createPortal to render into the header slots.
 */
export function useAppHeaderTitle(title: ReactNode) {
  const ctx = useAppHeaderContext();

  useLayoutEffect(() => {
    ctx.setTitle(title);
  }, [title, ctx]);

  // Clean up title on unmount
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    return () => {
      ctxRef.current.setTitle('');
    };
  }, []);

  return ctx;
}

/**
 * Portal component that renders children into the header's right-side slot.
 * Must be rendered within a component tree that has AppHeaderProvider above it.
 * Because this uses createPortal, children maintain their original React context
 * (e.g. KanbanProvider), solving the context-outside-provider problem.
 */
export function HeaderRightSlot({ children }: { children: ReactNode }) {
  const { rightSlot } = useAppHeaderContext();
  if (!rightSlot) {
    return null;
  }
  return createPortal(children, rightSlot);
}

/**
 * Portal component that renders children into the header's left-extra slot.
 */
export function HeaderLeftExtraSlot({ children }: { children: ReactNode }) {
  const { leftExtraSlot } = useAppHeaderContext();
  if (!leftExtraSlot) {
    return null;
  }
  return createPortal(children, leftExtraSlot);
}

/**
 * Simple convenience hook that just sets the header title.
 * Use HeaderRightSlot/HeaderLeftExtraSlot components for slot content.
 */
export function useAppHeader({ title }: { title: ReactNode }) {
  useAppHeaderTitle(title);
}
