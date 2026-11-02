import {
  httpBatchLink,
  httpBatchStreamLink,
  httpLink,
  splitLink,
  type TRPCClient,
} from '@trpc/client';
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
        // Imports have their own bounded request envelope and must never share a mutation batch.
        condition: (operation) =>
          operation.type === 'mutation' && operation.path === 'admin.importData',
        true: httpLink({ url: `${getBaseUrl()}/api/trpc`, transformer: superjson }),
        false: splitLink({
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
      }),
    ],
  });
}
