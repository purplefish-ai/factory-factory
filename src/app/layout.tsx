import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata } from 'next';
import './globals.css';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '../frontend/components/app-sidebar';
import { TRPCProvider } from '../frontend/lib/providers';

export const metadata: Metadata = {
  title: 'FACTORY FACTORY',
  description: 'Autonomous software development orchestration system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans antialiased">
        <TRPCProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="p-3">{children}</SidebarInset>
          </SidebarProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
