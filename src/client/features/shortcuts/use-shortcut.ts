import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import {
  formatShortcut,
  getShortcut,
  SHORTCUTS,
  type ShortcutCommandSection,
  type ShortcutId,
} from '@/client/lib/keyboard-shortcuts';
import {
  getShortcutHandlersVersion,
  hasShortcutHandler,
  registerShortcutHandler,
  type ShortcutHandler,
  subscribeToShortcutHandlers,
  triggerShortcut,
} from '@/client/lib/shortcut-registry';

/**
 * Binds `handler` to a registry shortcut while mounted and `enabled`. The
 * shortcut's context guard decides where it fires; the latest handler is used
 * without re-registering on every render.
 */
export function useShortcut(
  id: ShortcutId,
  handler: ShortcutHandler,
  enabled = true,
  available?: () => boolean
) {
  const availabilityRef = useRef(available);
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
    availabilityRef.current = available;
  });
  useEffect(() => {
    if (!enabled) {
      return;
    }
    return registerShortcutHandler(
      id,
      (event) => handlerRef.current(event),
      () => availabilityRef.current?.() ?? true
    );
  }, [id, enabled]);
}

export interface ShortcutCommand {
  id: ShortcutId;
  label: string;
  section: ShortcutCommandSection;
  keywords: readonly string[];
  /** Primary key label, such as `⌥↓`, or null for ⌘K-only commands. */
  shortcut: string | null;
}

/** ⌘K commands whose shortcuts currently have a handler, in registry order. */
export function useShortcutCommands(): ShortcutCommand[] {
  useSyncExternalStore(
    subscribeToShortcutHandlers,
    getShortcutHandlersVersion,
    getShortcutHandlersVersion
  );
  return SHORTCUTS.flatMap((definition) => {
    const { command } = getShortcut(definition.id);
    if (!(command && hasShortcutHandler(definition.id))) {
      return [];
    }
    return [
      {
        id: definition.id,
        label: command.label,
        section: command.section,
        keywords: command.keywords ?? [],
        shortcut: formatShortcut(definition.id),
      },
    ];
  });
}

export function runShortcutCommand(id: ShortcutId): boolean {
  return triggerShortcut(id);
}
