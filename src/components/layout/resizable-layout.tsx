import type { ReactNode } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { AppHeader } from '@/frontend/components/app-header';
import { AppHeaderProvider } from '@/frontend/components/app-header-context';
import { cn } from '@/lib/utils';

interface AppLayoutProps {
  children: ReactNode;
  className?: string;
}

export function AppLayout({ children, className }: AppLayoutProps) {
  return (
    <TooltipProvider delayDuration={0}>
      <AppHeaderProvider>
        <div className={cn('h-full w-full flex flex-col', className)}>
          <AppHeader />
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
            {children}
          </main>
        </div>
      </AppHeaderProvider>
    </TooltipProvider>
  );
}
