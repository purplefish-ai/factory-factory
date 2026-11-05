import { PageSearchSlot } from '@/client/components/app-header-context';
import { KanbanControls } from './kanban-controls';

/** Main-pane actions for the phone board. Search keeps one global instance. */
export function KanbanToolbar() {
  return (
    <div aria-label="Board toolbar" role="toolbar" className="flex shrink-0 items-center gap-2">
      <PageSearchSlot />
      <KanbanControls />
    </div>
  );
}
