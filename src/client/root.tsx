import { Outlet } from 'react-router';
import { ResizableLayout } from '@/components/layout/resizable-layout';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/frontend/components/app-sidebar';
import { CLIHealthBanner } from '@/frontend/components/cli-health-banner';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider } from '@/frontend/lib/providers';

export function Root() {
  return (
    <ThemeProvider>
      <TRPCProvider>
        <div className="flex h-screen flex-col">
          <CLIHealthBanner />
          <ResizableLayout sidebar={<AppSidebar />} className="flex-1 overflow-hidden">
            <Outlet />
          </ResizableLayout>
        </div>
        <Toaster />
      </TRPCProvider>
    </ThemeProvider>
  );
}
