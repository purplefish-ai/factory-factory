import {
  getShortcut,
  getShortcutEnvironment,
  isShortcutBlocked,
  matchesShortcut,
  type ShortcutId,
} from '@/client/lib/keyboard-shortcuts';

/** Return `false` to let the key through, for example when there is nothing to move to. */
export type ShortcutHandler =
  | ((event?: KeyboardEvent) => boolean | undefined)
  | ((event?: KeyboardEvent) => void);

// The most recently registered handler for an id wins, so a nested surface (a
// second composer, a dialog's own list) temporarily owns a shortcut and the
// previous owner resumes when it unmounts.
const handlers = new Map<ShortcutId, ShortcutHandler[]>();
const listeners = new Set<() => void>();
let version = 0;
let listening = false;

function notify() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  const environment = getShortcutEnvironment();
  for (const [id, stack] of handlers) {
    const handler = stack.at(-1);
    if (
      !(handler && matchesShortcut(event, id, environment)) ||
      isShortcutBlocked(event, getShortcut(id))
    ) {
      continue;
    }
    if (handler(event) === false) {
      continue;
    }
    event.preventDefault();
    return;
  }
}

function updateListener() {
  if (typeof window === 'undefined') {
    return;
  }
  const shouldListen = handlers.size > 0;
  if (shouldListen && !listening) {
    window.addEventListener('keydown', handleKeyDown);
  } else if (!shouldListen && listening) {
    window.removeEventListener('keydown', handleKeyDown);
  }
  listening = shouldListen;
}

/** Binds a handler to a registry shortcut; returns the unregister function. */
export function registerShortcutHandler(id: ShortcutId, handler: ShortcutHandler): () => void {
  const stack = handlers.get(id) ?? [];
  stack.push(handler);
  handlers.set(id, stack);
  updateListener();
  notify();
  return () => {
    const current = handlers.get(id);
    const index = current?.lastIndexOf(handler) ?? -1;
    if (!current || index < 0) {
      return;
    }
    current.splice(index, 1);
    if (current.length === 0) {
      handlers.delete(id);
    }
    updateListener();
    notify();
  };
}

export function hasShortcutHandler(id: ShortcutId): boolean {
  return Boolean(handlers.get(id)?.length);
}

/** Runs a shortcut's current handler without a key press, as ⌘K commands do. */
export function triggerShortcut(id: ShortcutId): boolean {
  const handler = handlers.get(id)?.at(-1);
  if (!handler) {
    return false;
  }
  return handler() !== false;
}

export function subscribeToShortcutHandlers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getShortcutHandlersVersion(): number {
  return version;
}
