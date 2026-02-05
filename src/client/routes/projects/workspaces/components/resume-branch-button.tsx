import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ResumeBranchButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <GitBranch className="h-4 w-4 mr-2" />
      Resume branch
    </Button>
  );
}
