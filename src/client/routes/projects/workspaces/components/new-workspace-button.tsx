import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';

export function NewWorkspaceButton({
  onClick,
  isCreating,
  children = 'Workspace',
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
        variant="outline"
        className="h-8 w-8"
        onClick={onClick}
        disabled={isCreating}
      >
        {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      </Button>
    );
  }

  return (
    <Button size="sm" onClick={onClick} disabled={isCreating}>
      {isCreating ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Plus className="h-4 w-4 mr-2" />
      )}
      {children}
    </Button>
  );
}
