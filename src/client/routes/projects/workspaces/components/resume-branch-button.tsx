import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';

export function ResumeBranchButton({ onClick }: { onClick: () => void }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return null;
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <GitBranch className="h-4 w-4 mr-2" />
      Resume branch
    </Button>
  );
}
