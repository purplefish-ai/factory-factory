import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { SettingsTabsList } from './settings-tabs-list';

export function SettingsPageLayout({
  children,
  breadcrumb,
  projectSettings = false,
}: {
  children: ReactNode;
  breadcrumb?: ReactNode;
  projectSettings?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6 p-3 md:p-6">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          {breadcrumb ?? (
            <>
              <Link className="underline" to="/">
                Board
              </Link>{' '}
              /{' '}
              <Link className="underline" to="/admin">
                Settings
              </Link>
            </>
          )}
        </nav>
        <SettingsTabsList projectSettings={projectSettings} />
        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}
