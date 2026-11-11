import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { IconButton } from '@/client/components/icon-button';
import { useWorkspacePanel } from '@/client/features/workspace';
import { cn } from '@/lib/utils';

export function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <IconButton
      label={rightPanelVisible ? 'Hide right panel' : 'Show right panel'}
      size="icon-sm"
      onClick={toggleRightPanel}
    >
      <SidebarSimpleIcon mirrored className={cn(rightPanelVisible && 'text-primary')} />
    </IconButton>
  );
}
