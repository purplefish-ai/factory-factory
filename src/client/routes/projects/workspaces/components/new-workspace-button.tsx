import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function NewWorkspaceButton({
  onClick,
  isCreating,
  children = 'New Workspace',
}: {
  onClick: () => void;
  isCreating: boolean;
  children?: React.ReactNode;
}) {
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
