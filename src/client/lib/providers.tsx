import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createAppQueryClient } from './query-client';
import { createTrpcClient, trpc } from './trpc';

/** Non-archived projects; `undefined` until the list loads, and after a failed load. */
export function useProjects() {
  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });
  return { projects };
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createAppQueryClient);

  const [trpcClient] = useState(createTrpcClient);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
