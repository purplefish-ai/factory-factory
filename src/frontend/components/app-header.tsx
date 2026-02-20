import { Menu, PanelLeft } from 'lucide-react';
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
          className="h-9 w-9 shrink-0"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
        >
          {isMobile ? <Menu className="h-5 w-5" /> : <PanelLeft className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Toggle sidebar</TooltipContent>
    </Tooltip>
  );
}

export function AppHeader() {
  const { title, setRightSlot, setLeftExtraSlot } = useAppHeaderContext();

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-2 min-h-12 pt-[env(safe-area-inset-top)]">
      <SidebarToggleButton />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{title}</span>
        <div ref={setLeftExtraSlot} className="flex shrink-0 items-center gap-1" />
      </div>
      <div ref={setRightSlot} className="ml-auto flex shrink-0 items-center gap-1" />
    </header>
  );
}
