import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

interface WorkspacesBackLinkProps {
  projectSlug: string;
}

/**
 * Reusable component for linking back to the workspaces board.
 * Keeps the Board destination accessible at every screen size.
 */
export function WorkspacesBackLink({ projectSlug }: WorkspacesBackLinkProps) {
  return (
    <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" asChild>
      <Link to={`/projects/${projectSlug}/workspaces`}>
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        <span>Back to Board</span>
      </Link>
    </Button>
  );
}
