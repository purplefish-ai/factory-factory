import { Outlet } from 'react-router';
import { ResizableLayout } from '@/components/layout/resizable-layout';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/frontend/components/app-sidebar';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider } from '@/frontend/lib/providers';

export function Root() {
  return (
    <ThemeProvider>
      <TRPCProvider>
        <ResizableLayout sidebar={<AppSidebar />}>
          <Outlet />
        </ResizableLayout>
        <Toaster />
      </TRPCProvider>
    </ThemeProvider>
  );
}
