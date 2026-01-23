import type { Metadata } from 'next';
import './globals.css';
import { TRPCProvider } from '../frontend/lib/providers';
import { Navigation } from '../frontend/components/navigation';

export const metadata: Metadata = {
  title: 'FactoryFactory',
  description: 'Autonomous software development orchestration system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <TRPCProvider>
          <div className="flex h-screen">
            <Navigation />
            <main className="flex-1 overflow-auto p-6">{children}</main>
          </div>
        </TRPCProvider>
      </body>
    </html>
  );
}
