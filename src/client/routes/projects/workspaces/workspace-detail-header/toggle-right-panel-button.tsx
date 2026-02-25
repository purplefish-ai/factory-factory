import { PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspacePanel } from '@/components/workspace';
import { cn } from '@/lib/utils';

export function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleRightPanel}
          className="h-6 w-6 md:h-8 md:w-8"
        >
          <PanelRight
            className={cn('h-3 w-3 md:h-4 md:w-4', rightPanelVisible && 'text-primary')}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{rightPanelVisible ? 'Hide right panel' : 'Show right panel'}</TooltipContent>
    </Tooltip>
  );
}
