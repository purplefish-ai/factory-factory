import { ListIcon } from '@phosphor-icons/react/dist/csr/List';
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { GlobalSearch } from '@/client/features/search';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAppHeaderContext } from './app-header-context';

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
          onClick={toggleSidebar}
        >
          {isMobile ? <ListIcon className="h-5 w-5" /> : <SidebarSimpleIcon className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Toggle sidebar</TooltipContent>
    </Tooltip>
  );
}

export function AppHeader() {
  const { title, setRightSlot, setLeftStartSlot, setLeftExtraSlot } = useAppHeaderContext();

  return (
    <header className="@container/header flex shrink-0 items-center gap-1 border-b bg-background px-2 min-h-12 pt-[env(safe-area-inset-top)] md:gap-x-2">
      <SidebarToggleButton />
      <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-2">
        <div ref={setLeftStartSlot} className="flex min-w-0 flex-1 items-center empty:hidden" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold empty:hidden">{title}</span>
        <div ref={setLeftExtraSlot} className="flex shrink-0 items-center gap-1 empty:hidden" />
      </div>
      <div ref={setRightSlot} className="ml-auto flex shrink-0 items-center gap-1 empty:hidden" />
      <GlobalSearch />
    </header>
  );
}
