import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

interface WorkspacesBackLinkProps {
  projectSlug: string;
}

/**
 * Reusable component for linking back to the workspaces board.
 * Displays "Workspaces" with an arrow icon, responsive to screen size.
 */
export function WorkspacesBackLink({ projectSlug }: WorkspacesBackLinkProps) {
  return (
    <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" asChild>
      <Link to={`/projects/${projectSlug}/workspaces`}>
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Workspaces</span>
      </Link>
    </Button>
  );
}
