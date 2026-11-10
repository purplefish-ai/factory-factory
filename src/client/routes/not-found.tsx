import { CompassIcon } from '@phosphor-icons/react/dist/csr/Compass';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Button } from '@/components/ui/button';

/** Unmatched URLs render inside the app shell, so the sidebar stays available. */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <EmptyState
      icon={CompassIcon}
      title="Page not found"
      description={
        <>
          Nothing lives at <code className="break-all font-mono">{pathname}</code>.
        </>
      }
      action={
        <Button asChild variant="outline">
          <Link to="/">Go to home</Link>
        </Button>
      }
      className="h-full"
    />
  );
}
