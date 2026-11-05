import { ListIcon } from '@phosphor-icons/react/dist/csr/List';
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { createPortal } from 'react-dom';
import { GlobalSearch } from '@/client/features/search';
import { ShortcutKeys } from '@/client/features/shortcuts';
import { getAriaKeyShortcuts } from '@/client/lib/keyboard-shortcuts';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAppHeaderContext } from './app-header-context';
import './app-header.css';

function SidebarToggleButton() {
  const { toggleSidebar } = useSidebar();
  const isMobile = useIsMobile();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 md:h-9 md:w-9"
          aria-label="Toggle sidebar"
          aria-keyshortcuts={getAriaKeyShortcuts('app.toggleSidebar')}
          onClick={toggleSidebar}
        >
          {isMobile ? <ListIcon className="h-5 w-5" /> : <SidebarSimpleIcon className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        Toggle sidebar
        <ShortcutKeys id="app.toggleSidebar" />
      </TooltipContent>
    </Tooltip>
  );
}

export function AppHeader({ showSidebarToggle = true }: { showSidebarToggle?: boolean }) {
  const isMobile = useIsMobile();
  const { title, searchSlot, setRightSlot, setRightEndSlot, setLeftStartSlot, setLeftExtraSlot } =
    useAppHeaderContext();

  return (
    <header className="app-header flex shrink-0 items-stretch border-b bg-shell px-2 min-h-12 pt-[env(safe-area-inset-top)]">
      <div className="app-header-controls @container/header flex min-w-0 flex-1 items-center gap-1 md:gap-x-2">
        {showSidebarToggle ? <SidebarToggleButton /> : null}
        <div data-slot="header-context" className="flex min-w-0 flex-1 items-center gap-1 md:gap-2">
          <div ref={setLeftStartSlot} className="flex min-w-0 flex-1 items-center empty:hidden" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold empty:hidden">
            {title}
          </span>
          <div ref={setLeftExtraSlot} className="flex shrink-0 items-center gap-1 empty:hidden" />
        </div>
        <div ref={setRightSlot} className="ml-auto flex shrink-0 items-center gap-1 empty:hidden" />
        {isMobile && searchSlot ? (
          createPortal(<GlobalSearch expanded />, searchSlot)
        ) : (
          <GlobalSearch />
        )}
        <div ref={setRightEndSlot} className="flex shrink-0 items-center empty:hidden" />
      </div>
    </header>
  );
}
