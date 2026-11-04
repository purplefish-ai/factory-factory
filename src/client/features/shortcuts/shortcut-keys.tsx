import {
  getChordKeys,
  getShortcutChords,
  getShortcutEnvironment,
  type KeyChord,
  type ShortcutEnvironment,
  type ShortcutId,
} from '@/client/lib/keyboard-shortcuts';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

// Screen readers announce symbols inconsistently, so key caps carry spoken names.
const SPOKEN_KEYS: Record<string, string> = {
  '⌘': 'Command',
  '⌥': 'Option',
  '⇧': 'Shift',
  '⌃': 'Control',
  '↵': 'Return',
  '⇥': 'Tab',
  '⌫': 'Delete',
  '⌦': 'Forward Delete',
  '↑': 'Up Arrow',
  '↓': 'Down Arrow',
  '←': 'Left Arrow',
  '→': 'Right Arrow',
  '?': 'Question mark',
  '/': 'Slash',
  '.': 'Period',
  '[': 'Left bracket',
  ']': 'Right bracket',
};

function chordLabel(keys: string[]) {
  return keys.map((key) => SPOKEN_KEYS[key] ?? key).join('+');
}

export function ChordKeys({
  chord,
  environment = getShortcutEnvironment(),
  className,
}: {
  chord: KeyChord;
  environment?: ShortcutEnvironment;
  className?: string;
}) {
  const keys = getChordKeys(chord, environment.platform);
  return (
    <KbdGroup className={className}>
      <span className="sr-only">{chordLabel(keys)}</span>
      {keys.map((key) => (
        <Kbd key={key} aria-hidden="true">
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

/**
 * Key caps for a registry shortcut. `all` lists every chord available in this
 * runtime ("⌥⇧P or ⌘⇧P"); otherwise only the primary chord is shown.
 */
export function ShortcutKeys({
  id,
  all = false,
  environment = getShortcutEnvironment(),
  className,
}: {
  id: ShortcutId;
  all?: boolean;
  environment?: ShortcutEnvironment;
  className?: string;
}) {
  const chords = getShortcutChords(id, environment);
  const shown = all ? chords : chords.slice(0, 1);
  if (!shown.length) {
    return null;
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center justify-end gap-1', className)}>
      {shown.map((chord, index) => (
        <span key={chordLabel(getChordKeys(chord, environment.platform))}>
          {index > 0 && <span className="mr-1 text-xs text-muted-foreground">or</span>}
          <ChordKeys chord={chord} environment={environment} />
        </span>
      ))}
    </span>
  );
}
