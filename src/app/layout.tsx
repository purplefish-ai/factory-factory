import type { Metadata } from 'next';
import './globals.css';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '../frontend/components/app-sidebar';
import { TRPCProvider } from '../frontend/lib/providers';

export const metadata: Metadata = {
  title: 'FactoryFactory',
  description: 'Autonomous software development orchestration system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background">
        <TRPCProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="p-6">{children}</SidebarInset>
          </SidebarProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
