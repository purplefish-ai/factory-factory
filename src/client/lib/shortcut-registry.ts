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
interface Registration {
  handler: ShortcutHandler;
  available: () => boolean;
}
const handlers = new Map<ShortcutId, Registration[]>();
const listeners = new Set<() => void>();
let version = 0;
let listening = false;

function notify() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function currentRegistration(id: ShortcutId): Registration | undefined {
  const stack = handlers.get(id) ?? [];
  for (let index = stack.length - 1; index >= 0; index--) {
    const entry = stack[index];
    if (entry?.available()) {
      return entry;
    }
  }
  return undefined;
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  const environment = getShortcutEnvironment();
  for (const id of handlers.keys()) {
    const handler = currentRegistration(id)?.handler;
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
export function registerShortcutHandler(
  id: ShortcutId,
  handler: ShortcutHandler,
  available: () => boolean = () => true
): () => void {
  const registration = { handler, available };
  const stack = handlers.get(id) ?? [];
  stack.push(registration);
  handlers.set(id, stack);
  updateListener();
  notify();
  return () => {
    const current = handlers.get(id);
    const index = current?.indexOf(registration) ?? -1;
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
  return Boolean(currentRegistration(id));
}

/** Runs a shortcut's current handler without a key press, as ⌘K commands do. */
export function triggerShortcut(id: ShortcutId): boolean {
  const registration = currentRegistration(id);
  if (!registration) {
    return false;
  }
  return registration.handler() !== false;
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
