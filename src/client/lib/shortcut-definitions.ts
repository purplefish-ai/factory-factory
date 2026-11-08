import type { KeyChord, ShortcutDefinition } from './shortcut-types';

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
    chords: [{ key: 'n', mod: true, runtime: 'electron' }],
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
    description: 'Go to Automations',
    chords: [],
    context: 'anywhere',
    command: {
      label: 'Automations',
      section: 'Go to',
      keywords: ['scheduled', 'event', 'automation', 'agents'],
    },
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
    chords: [{ key: ',', mod: true, runtime: 'electron' }],
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
    context: 'outside-text',
    allowRepeat: true,
    command: { label: 'Previous workspace', section: 'Go to' },
  },
  {
    id: 'workspace.next',
    scope: 'navigation',
    description: 'Next workspace',
    chords: [{ key: 'ArrowDown', alt: true }],
    context: 'outside-text',
    allowRepeat: true,
    command: { label: 'Next workspace', section: 'Go to' },
  },
  {
    id: 'workspace.nextNeedsInput',
    scope: 'navigation',
    description: 'Next workspace that needs input',
    chords: [{ key: 'ArrowDown', alt: true, shift: true }],
    context: 'outside-text',
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
    command: {
      label: 'Focus composer',
      section: 'Actions',
      keywords: ['message', 'type', 'input'],
    },
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
