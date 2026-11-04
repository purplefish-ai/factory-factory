import { getShortcut, type ShortcutId } from './shortcut-definitions';
import type {
  KeyChord,
  ShortcutDefinition,
  ShortcutEnvironment,
  ShortcutPlatform,
} from './shortcut-types';
export { getShortcut, SHORTCUTS } from './shortcut-definitions';
export type { ShortcutId } from './shortcut-definitions';
export { SHORTCUT_SCOPE_LABELS } from './shortcut-types';
export type {
  KeyChord,
  ShortcutDefinition,
  ShortcutEnvironment,
  ShortcutPlatform,
  ShortcutScope,
  ShortcutCommandSection,
} from './shortcut-types';

// =============================================================================
// Environment
// =============================================================================

export function detectShortcutEnvironment(): ShortcutEnvironment {
  const platformHint =
    typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`;
  return {
    platform: /mac|iphone|ipad|ipod/i.test(platformHint) ? 'mac' : 'other',
    runtime:
      typeof window !== 'undefined' && window.electronAPI?.isElectron ? 'electron' : 'browser',
  };
}

let cachedEnvironment: ShortcutEnvironment | null = null;

/** The current platform and runtime; neither changes while the app runs. */
export function getShortcutEnvironment(): ShortcutEnvironment {
  cachedEnvironment ??= detectShortcutEnvironment();
  return cachedEnvironment;
}

/** Test hook: pass `null` to detect the environment again. */
export function setShortcutEnvironmentForTesting(environment: ShortcutEnvironment | null) {
  cachedEnvironment = environment;
}

/** Chords that apply in this runtime, in display order. */
export function getShortcutChords(
  id: ShortcutId,
  environment: ShortcutEnvironment = getShortcutEnvironment()
): KeyChord[] {
  return getShortcut(id).chords.filter(
    (chord) =>
      (!chord.runtime || chord.runtime === environment.runtime) &&
      (!chord.platform || chord.platform === environment.platform)
  );
}

// =============================================================================
// Matching
// =============================================================================

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function matchesChord(event: ShortcutKeyEvent, chord: KeyChord): boolean {
  const keyMatches = chord.code
    ? event.code === chord.code
    : normalizeKey(event.key) === normalizeKey(chord.key);
  if (!keyMatches) {
    return false;
  }
  if (chord.mod) {
    if (!(event.metaKey || event.ctrlKey)) {
      return false;
    }
  } else if (event.metaKey || event.ctrlKey !== Boolean(chord.ctrl)) {
    // Without `mod`, ⌘ is never part of the chord and Ctrl only when `ctrl` asks for it.
    return false;
  }
  if (event.altKey !== Boolean(chord.alt)) {
    return false;
  }
  return chord.shift === 'any' || event.shiftKey === Boolean(chord.shift);
}

export function matchesShortcut(
  event: ShortcutKeyEvent,
  id: ShortcutId,
  environment: ShortcutEnvironment = getShortcutEnvironment()
): boolean {
  return getShortcutChords(id, environment).some((chord) => matchesChord(event, chord));
}

// =============================================================================
// Guards
// =============================================================================

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
  '[role="textbox"], [role="searchbox"], [role="combobox"]';
// Arrow keys and letters drive these widgets (Alt+↓ opens a select, letters type-ahead).
const WIDGET_SELECTOR =
  'select, [role="combobox"], [role="listbox"], [role="option"], [role="menu"], ' +
  '[role="menubar"], [role^="menuitem"]';
const MODAL_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]';
const TERMINAL_SELECTOR = '.xterm';

function getEventElement(event: KeyboardEvent): Element | null {
  if (event.target instanceof Element) {
    return event.target;
  }
  return typeof document === 'undefined' ? null : document.activeElement;
}

function blocksNativeShortcutContext(
  event: KeyboardEvent,
  definition: ShortcutDefinition,
  target: Element
): boolean {
  if (!definition.allowInDialog && target.closest(MODAL_SELECTOR)) {
    return true;
  }
  // ⌘/Ctrl chords (⌘K, ⌘B) mean nothing to these widgets; arrows and letters do.
  if (!(event.metaKey || event.ctrlKey) && target.closest(WIDGET_SELECTOR)) {
    return true;
  }
  // Option/Alt bracket chords type punctuation on macOS and other layouts.
  if (event.altKey && target.closest(EDITABLE_SELECTOR)) {
    return true;
  }
  return !definition.allowInTerminal && Boolean(target.closest(TERMINAL_SELECTOR));
}

/**
 * True when a matched global shortcut should yield to the focused element or an
 * earlier handler. `element` shortcuts are routed by their own control and
 * never fire globally.
 */
export function isShortcutBlocked(event: KeyboardEvent, definition: ShortcutDefinition): boolean {
  if (event.defaultPrevented || event.isComposing || definition.context === 'element') {
    return true;
  }
  if (event.repeat && !definition.allowRepeat) {
    return true;
  }
  const target = getEventElement(event);
  if (!target) {
    return false;
  }
  if (blocksNativeShortcutContext(event, definition, target)) {
    return true;
  }
  if (definition.context === 'anywhere') {
    return false;
  }
  if (target.closest(EDITABLE_SELECTOR)) {
    return true;
  }
  if (definition.context === 'reviews') {
    const control = target.closest('button, a[href]');
    return (
      !!control &&
      !control.matches(
        '[data-review-row][aria-current="true"], [data-review-tab="info"], [data-review-tab="diff"]'
      )
    );
  }
  return false;
}

// =============================================================================
// Display
// =============================================================================

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Tab: '⇥',
  Delete: '⌦',
  Backspace: '⌫',
  Escape: 'Esc',
};
const OTHER_KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Delete: 'Del',
};

/** Key caps for one chord, e.g. `['⌥', '⇧', 'P']` on macOS or `['Alt', 'Shift', 'P']`. */
export function getChordKeys(chord: KeyChord, platform: ShortcutPlatform): string[] {
  const mac = platform === 'mac';
  const modifiers = mac
    ? { control: '⌃', alt: '⌥', shift: '⇧' }
    : { control: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  // Platform conventions: ⌃⌥⇧⌘ on macOS, Ctrl+Alt+Shift elsewhere.
  const keys: string[] = [];
  if (chord.ctrl || (chord.mod && !mac)) {
    keys.push(modifiers.control);
  }
  if (chord.alt) {
    keys.push(modifiers.alt);
  }
  if (chord.shift === true) {
    keys.push(modifiers.shift);
  }
  if (chord.mod && mac) {
    keys.push('⌘');
  }
  const labels = mac ? MAC_KEY_LABELS : OTHER_KEY_LABELS;
  keys.push(labels[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
  return keys;
}

/** Compact label for tooltips: `⌥⇧P` on macOS, `Alt+Shift+P` elsewhere. */
export function formatChord(chord: KeyChord, platform: ShortcutPlatform): string {
  return getChordKeys(chord, platform).join(platform === 'mac' ? '' : '+');
}

/** Label for the primary chord in this runtime, or null for ⌘K-only commands. */
export function formatShortcut(
  id: ShortcutId,
  environment: ShortcutEnvironment = getShortcutEnvironment()
): string | null {
  const [chord] = getShortcutChords(id, environment);
  return chord ? formatChord(chord, environment.platform) : null;
}

function getAriaKey(chord: KeyChord): string {
  if (chord.key === ' ') {
    return 'Space';
  }
  return chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
}

/** `aria-keyshortcuts` value listing every chord available in this runtime. */
export function getAriaKeyShortcuts(
  id: ShortcutId,
  environment: ShortcutEnvironment = getShortcutEnvironment()
): string | undefined {
  const values = getShortcutChords(id, environment).map((chord) => {
    const parts: string[] = [];
    if (chord.ctrl || (chord.mod && environment.platform !== 'mac')) {
      parts.push('Control');
    }
    if (chord.alt) {
      parts.push('Alt');
    }
    if (chord.shift === true) {
      parts.push('Shift');
    }
    if (chord.mod && environment.platform === 'mac') {
      parts.push('Meta');
    }
    parts.push(getAriaKey(chord));
    return parts.join('+');
  });
  return values.length ? values.join(' ') : undefined;
}
