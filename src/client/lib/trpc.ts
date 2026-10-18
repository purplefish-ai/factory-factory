import { httpBatchLink, httpBatchStreamLink, splitLink, type TRPCClient } from '@trpc/client';
import type { CreateTRPCReact } from '@trpc/react-query';
import { createTRPCReact } from '@trpc/react-query';
import superjson from 'superjson';
import type { AppRouter } from '@/backend/trpc';

// Re-export AppRouter type for use in frontend components
export type { AppRouter };

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export const getBaseUrl = () => {
  // Use relative path - works in both dev (Vite proxy) and prod (same origin)
  return '';
};

/** Creates the shared tRPC client. */
export function createTrpcClient(): TRPCClient<AppRouter> {
  return trpc.createClient({
    links: [
      splitLink({
        // Query results can arrive independently; mutations retain response-header support.
        condition: (operation) => operation.type === 'query',
        true: httpBatchStreamLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
        false: httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      }),
    ],
  });
}
