import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import type { ShortcutCommand } from '@/client/features/shortcuts';
import type { ShortcutCommandSection, ShortcutId } from '@/client/lib/keyboard-shortcuts';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';

const SECTIONS: ShortcutCommandSection[] = ['Go to', 'Actions'];
const SECTION_ICONS = { 'Go to': ArrowRightIcon, Actions: LightningIcon };

export function getCommandValue(id: ShortcutId): string {
  return `command:${id}`;
}

/**
 * Commands whose label or keywords contain every query word. An empty query
 * lists them all so ⌘K doubles as a command menu.
 */
export function filterCommands(
  commands: readonly ShortcutCommand[],
  query: string
): ShortcutCommand[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [...commands];
  }
  return commands.filter((command) => {
    const haystack = [command.label, command.section, ...command.keywords].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function SearchCommands({
  commands,
  onSelect,
}: {
  commands: readonly ShortcutCommand[];
  onSelect: (id: ShortcutId) => void;
}) {
  return SECTIONS.map((section) => {
    const items = commands.filter((command) => command.section === section);
    if (!items.length) {
      return null;
    }
    const Icon = SECTION_ICONS[section];
    return (
      <CommandGroup key={section} heading={section} className="p-0">
        {items.map((command) => (
          <CommandItem
            key={command.id}
            value={getCommandValue(command.id)}
            onSelect={() => onSelect(command.id)}
            className="min-h-10 cursor-pointer gap-3 rounded-lg px-3"
          >
            <Icon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{command.label}</span>
            {command.shortcut && (
              <Kbd className="shrink-0" aria-hidden="true">
                {command.shortcut}
              </Kbd>
            )}
          </CommandItem>
        ))}
      </CommandGroup>
    );
  });
}
