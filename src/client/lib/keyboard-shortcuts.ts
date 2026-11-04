/**
 * Central keyboard shortcut registry: every app shortcut is defined here once,
 * and the help dialog, ⌘K commands, tooltips, `aria-keyshortcuts` and the key
 * handlers all read these definitions. See docs/keyboard-shortcuts.md.
 */

export type ShortcutPlatform = 'mac' | 'other';
/** `electron` is the desktop app; `browser` includes installed PWAs, which keep browser keys. */
export type ShortcutRuntime = 'electron' | 'browser';

export interface ShortcutEnvironment {
  platform: ShortcutPlatform;
  runtime: ShortcutRuntime;
}

/**
 * One key chord. Modifiers default to "not pressed", so `{ key: 'j' }` does not
 * match ⌘J. `mod` is ⌘ on macOS and Ctrl elsewhere; like the shortcuts it
 * replaces, it accepts either key so Ctrl+Enter keeps working on macOS.
 */
export interface KeyChord {
  /** `KeyboardEvent.key`; single characters compare case-insensitively. */
  key: string;
  /**
   * `KeyboardEvent.code`, for Alt chords: macOS turns ⌥P into "π", so the
   * physical key is matched instead and `key` is only the label.
   */
  code?: string;
  mod?: boolean;
  /** The literal Control key on every platform (⌃ on macOS). */
  ctrl?: boolean;
  alt?: boolean;
  /** `'any'` for characters such as `?` that need Shift on some layouts only. */
  shift?: boolean | 'any';
  /** Restricts the chord to one runtime, for keys a browser reserves. */
  runtime?: ShortcutRuntime;
  /** Restricts the chord to one platform, such as ⌫ on Mac keyboards without ⌦. */
  platform?: ShortcutPlatform;
}

/**
 * Where a shortcut may fire:
 * - `anywhere`: modifier chords that also work while typing.
 * - `outside-text`: plain keys that yield to text fields, menus and dialogs.
 * - `reviews`: `outside-text` that also yields to unrelated buttons and links,
 *   except review rows and tabs, where letter keys have no native meaning.
 * - `element`: handled by the focused control's own keydown handler, such as
 *   the composer or a tab.
 */
export type ShortcutContext = 'anywhere' | 'outside-text' | 'reviews' | 'element';

export type ShortcutScope = 'general' | 'navigation' | 'workspace' | 'composer' | 'reviews';

export const SHORTCUT_SCOPE_LABELS: Record<ShortcutScope, string> = {
  general: 'General',
  navigation: 'Navigation',
  workspace: 'Workspace',
  composer: 'Composer',
  reviews: 'Reviews',
};

export type ShortcutCommandSection = 'Go to' | 'Actions';

export interface ShortcutDefinition {
  id: string;
  scope: ShortcutScope;
  description: string;
  /** Empty for ⌘K-only commands. The first chord available in a runtime is the one shown. */
  chords: readonly KeyChord[];
  context: ShortcutContext;
  /** Fires while a modal dialog has focus (the ⌘K toggle closes its own dialog). */
  allowInDialog?: boolean;
  /** Fires inside the terminal; Alt chords belong to terminal programs. */
  allowInTerminal?: boolean;
  /** Keeps firing while the key auto-repeats, for list navigation. */
  allowRepeat?: boolean;
  /** Listed in ⌘K while a handler is registered. */
  command?: { label: string; section: ShortcutCommandSection; keywords?: readonly string[] };
}

const alt = (key: string, code: string, extra: Partial<KeyChord> = {}): KeyChord => ({
  key,
  code,
  alt: true,
  ...extra,
});

export const SHORTCUTS = [
  {
    id: 'app.search',
    scope: 'general',
    description: 'Search or run a command',
    chords: [{ key: 'k', mod: true }],
    context: 'anywhere',
    allowInDialog: true,
    allowInTerminal: true,
  },
  {
    id: 'app.showShortcuts',
    scope: 'general',
    description: 'Show keyboard shortcuts',
    chords: [{ key: '?', shift: 'any' }],
    context: 'outside-text',
    command: {
      label: 'Show keyboard shortcuts',
      section: 'Actions',
      keywords: ['help', 'keys', 'hotkeys'],
    },
  },
  {
    id: 'app.toggleSidebar',
    scope: 'general',
    description: 'Toggle sidebar',
    chords: [{ key: 'b', mod: true }],
    context: 'anywhere',
    allowInTerminal: true,
    command: { label: 'Toggle sidebar', section: 'Actions', keywords: ['navigation', 'hide'] },
  },
  {
    id: 'nav.newWorkspace',
    scope: 'navigation',
    description: 'New workspace',
    chords: [],
    context: 'anywhere',
    command: { label: 'New workspace', section: 'Actions', keywords: ['create', 'start'] },
  },
  {
    id: 'nav.board',
    scope: 'navigation',
    description: 'Go to Board',
    chords: [],
    context: 'anywhere',
    command: { label: 'Board', section: 'Go to', keywords: ['kanban', 'workspaces'] },
  },
  {
    id: 'nav.agents',
    scope: 'navigation',
    description: 'Go to Agents',
    chords: [],
    context: 'anywhere',
    command: { label: 'Agents', section: 'Go to', keywords: ['scheduled', 'automation'] },
  },
  {
    id: 'nav.reviews',
    scope: 'navigation',
    description: 'Go to Reviews',
    chords: [],
    context: 'anywhere',
    command: { label: 'Reviews', section: 'Go to', keywords: ['pull requests', 'pr'] },
  },
  {
    id: 'nav.settings',
    scope: 'navigation',
    description: 'Go to Settings',
    chords: [],
    context: 'anywhere',
    command: { label: 'Settings', section: 'Go to', keywords: ['preferences', 'admin'] },
  },
  {
    id: 'nav.projects',
    scope: 'navigation',
    description: 'Switch project',
    chords: [],
    context: 'anywhere',
    command: { label: 'Switch project', section: 'Go to', keywords: ['projects'] },
  },
  {
    id: 'workspace.previous',
    scope: 'navigation',
    description: 'Previous workspace',
    chords: [{ key: 'ArrowUp', alt: true }],
    context: 'anywhere',
    allowRepeat: true,
    command: { label: 'Previous workspace', section: 'Go to' },
  },
  {
    id: 'workspace.next',
    scope: 'navigation',
    description: 'Next workspace',
    chords: [{ key: 'ArrowDown', alt: true }],
    context: 'anywhere',
    allowRepeat: true,
    command: { label: 'Next workspace', section: 'Go to' },
  },
  {
    id: 'workspace.nextNeedsInput',
    scope: 'navigation',
    description: 'Next workspace that needs input',
    chords: [{ key: 'ArrowDown', alt: true, shift: true }],
    context: 'anywhere',
    command: {
      label: 'Next workspace that needs input',
      section: 'Go to',
      keywords: ['waiting', 'attention', 'question', 'permission', 'approval'],
    },
  },
  {
    id: 'chat.previous',
    scope: 'workspace',
    description: 'Previous chat',
    chords: [alt('[', 'BracketLeft'), { key: 'Tab', ctrl: true, shift: true, runtime: 'electron' }],
    context: 'anywhere',
    allowRepeat: true,
    command: { label: 'Previous chat', section: 'Go to', keywords: ['session', 'tab'] },
  },
  {
    id: 'chat.next',
    scope: 'workspace',
    description: 'Next chat',
    chords: [alt(']', 'BracketRight'), { key: 'Tab', ctrl: true, runtime: 'electron' }],
    context: 'anywhere',
    allowRepeat: true,
    command: { label: 'Next chat', section: 'Go to', keywords: ['session', 'tab'] },
  },
  {
    id: 'chat.focusComposer',
    scope: 'workspace',
    description: 'Focus the composer',
    chords: [{ key: '/', shift: 'any' }],
    context: 'outside-text',
    command: { label: 'Focus composer', section: 'Actions', keywords: ['message', 'type', 'input'] },
  },
  {
    id: 'tabs.close',
    scope: 'workspace',
    description: 'Close the focused tab',
    chords: [
      { key: 'Backspace', platform: 'mac' },
      { key: 'Delete', platform: 'other' },
    ],
    context: 'element',
  },
  {
    id: 'composer.send',
    scope: 'composer',
    description: 'Send message',
    chords: [{ key: 'Enter' }, { key: 'Enter', mod: true }],
    context: 'element',
  },
  {
    id: 'composer.newLine',
    scope: 'composer',
    description: 'Insert a new line',
    chords: [{ key: 'Enter', shift: true }],
    context: 'element',
  },
  {
    id: 'composer.stop',
    scope: 'composer',
    description: 'Stop the agent',
    chords: [{ key: '.', mod: true }],
    context: 'element',
  },
  {
    id: 'composer.attachImage',
    scope: 'composer',
    description: 'Attach an image',
    chords: [{ key: 'u', mod: true, shift: true }],
    context: 'element',
  },
  // ⌘⇧P/T/A collide with browser keys (Firefox private window, Chrome reopen
  // tab and tab search), so the browser gets Alt chords and the desktop app
  // keeps the original keys as well.
  {
    id: 'composer.togglePlanMode',
    scope: 'composer',
    description: 'Toggle planning mode',
    chords: [
      alt('P', 'KeyP', { shift: true }),
      { key: 'p', mod: true, shift: true, runtime: 'electron' },
    ],
    context: 'element',
  },
  {
    id: 'composer.toggleThinking',
    scope: 'composer',
    description: 'Toggle extended thinking',
    chords: [
      alt('E', 'KeyE', { shift: true }),
      { key: 't', mod: true, shift: true, runtime: 'electron' },
    ],
    context: 'element',
  },
  {
    id: 'composer.quickActions',
    scope: 'composer',
    description: 'Open quick actions',
    chords: [
      alt('Q', 'KeyQ', { shift: true }),
      { key: 'a', mod: true, shift: true, runtime: 'electron' },
    ],
    context: 'element',
  },
  {
    id: 'reviews.next',
    scope: 'reviews',
    description: 'Next pull request',
    chords: [{ key: 'j' }],
    context: 'reviews',
    allowRepeat: true,
  },
  {
    id: 'reviews.previous',
    scope: 'reviews',
    description: 'Previous pull request',
    chords: [{ key: 'k' }],
    context: 'reviews',
    allowRepeat: true,
  },
  {
    id: 'reviews.openOnGitHub',
    scope: 'reviews',
    description: 'Open on GitHub',
    chords: [{ key: 'o' }],
    context: 'reviews',
  },
  {
    id: 'reviews.approve',
    scope: 'reviews',
    description: 'Approve pull request',
    chords: [{ key: 'a', shift: true }],
    context: 'reviews',
  },
  {
    id: 'reviews.showDiff',
    scope: 'reviews',
    description: 'Show diff',
    chords: [{ key: 'd' }],
    context: 'reviews',
  },
  {
    id: 'reviews.showInfo',
    scope: 'reviews',
    description: 'Show details',
    chords: [{ key: 'i' }],
    context: 'reviews',
  },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const definitionsById = new Map<string, ShortcutDefinition>(
  SHORTCUTS.map((definition) => [definition.id, definition])
);

export function getShortcut(id: ShortcutId): ShortcutDefinition {
  const definition = definitionsById.get(id);
  if (!definition) {
    throw new Error(`Unknown shortcut: ${id}`);
  }
  return definition;
}

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
  if (!definition.allowInDialog && target.closest(MODAL_SELECTOR)) {
    return true;
  }
  // ⌘/Ctrl chords (⌘K, ⌘B) mean nothing to these widgets; arrows and letters do.
  if (!(event.metaKey || event.ctrlKey) && target.closest(WIDGET_SELECTOR)) {
    return true;
  }
  if (definition.context === 'anywhere') {
    return !definition.allowInTerminal && Boolean(target.closest(TERMINAL_SELECTOR));
  }
  if (target.closest(EDITABLE_SELECTOR)) {
    return true;
  }
  if (definition.context === 'reviews') {
    const control = target.closest('button, a[href]');
    return !!control && !control.matches('[data-review-list] > button, [role="tab"]');
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
  // Platform conventions: ⌃⌥⇧⌘ on macOS, Ctrl+Alt+Shift elsewhere.
  const keys: string[] = [];
  if (chord.ctrl || (chord.mod && !mac)) {
    keys.push(mac ? '⌃' : 'Ctrl');
  }
  if (chord.alt) {
    keys.push(mac ? '⌥' : 'Alt');
  }
  if (chord.shift === true) {
    keys.push(mac ? '⇧' : 'Shift');
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
