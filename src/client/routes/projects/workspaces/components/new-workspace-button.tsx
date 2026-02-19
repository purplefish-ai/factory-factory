import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';

export function NewWorkspaceButton({
  onClick,
  isCreating,
  children = 'New Workspace',
}: {
  onClick: () => void;
  isCreating: boolean;
  children?: React.ReactNode;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Button
        size="icon"
        variant="ghost"
        className="h-9 w-9"
        onClick={() => onClick()}
        disabled={isCreating}
      >
        {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      </Button>
    );
  }

  return (
    <Button size="sm" variant="ghost" onClick={() => onClick()} disabled={isCreating}>
      {isCreating ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : (
        <Plus className="h-4 w-4 mr-1" />
      )}
      {children}
    </Button>
  );
}
