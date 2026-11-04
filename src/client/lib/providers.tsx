import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createAppQueryClient } from './query-client';
import { createTrpcClient, trpc } from './trpc';

/** Hook to get non-archived projects list - used for sidebar visibility */
export function useProjects() {
  const { data: projects, isLoading } = trpc.project.list.useQuery({ isArchived: false });
  return { projects, isLoading };
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
