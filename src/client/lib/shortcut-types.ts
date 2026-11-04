/**
 * Central keyboard shortcut registry: every app shortcut is defined here once,
 * and the help dialog, ⌘K commands, tooltips, `aria-keyshortcuts` and the key
 * handlers all read these definitions. See docs/keyboard-shortcuts.md.
 */

export type ShortcutPlatform = 'mac' | 'other';
/** `electron` is the desktop app; `browser` includes installed PWAs, which keep browser keys. */
type ShortcutRuntime = 'electron' | 'browser';

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
