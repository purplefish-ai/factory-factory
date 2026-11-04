import {
  getShortcutChords,
  getShortcutEnvironment,
  SHORTCUT_SCOPE_LABELS,
  SHORTCUTS,
  type ShortcutEnvironment,
  type ShortcutScope,
} from '@/client/lib/keyboard-shortcuts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ShortcutKeys } from './shortcut-keys';

const SCOPE_ORDER: ShortcutScope[] = ['general', 'navigation', 'workspace', 'composer', 'reviews'];

export interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Defaults to the detected platform and runtime; stories pin one. */
  environment?: ShortcutEnvironment;
}

/** The "?" help sheet, generated from the shortcut registry. */
export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  environment = getShortcutEnvironment(),
}: KeyboardShortcutsDialogProps) {
  const sections = SCOPE_ORDER.map((scope) => ({
    scope,
    shortcuts: SHORTCUTS.filter(
      (definition) =>
        definition.scope === scope && getShortcutChords(definition.id, environment).length > 0
    ),
  })).filter((section) => section.shortcuts.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <ShortcutKeys id="app.showShortcuts" environment={environment} /> to open this
            list. Search with <ShortcutKeys id="app.search" environment={environment} /> to find
            more commands.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="min-h-0"
          viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Shortcut list' }}
        >
          <div className="grid gap-x-8 gap-y-6 px-6 py-5 md:grid-cols-2">
            {sections.map(({ scope, shortcuts }) => (
              <section key={scope} aria-labelledby={`shortcut-scope-${scope}`}>
                <h3
                  id={`shortcut-scope-${scope}`}
                  className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {SHORTCUT_SCOPE_LABELS[scope]}
                </h3>
                <dl className="divide-y divide-border/60">
                  {shortcuts.map((definition) => (
                    <div
                      key={definition.id}
                      className="flex min-h-9 items-center justify-between gap-4 py-1.5"
                    >
                      <dt className="text-sm">{definition.description}</dt>
                      <dd>
                        <ShortcutKeys id={definition.id} all environment={environment} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
