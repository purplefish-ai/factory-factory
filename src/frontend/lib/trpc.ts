'use client';

import type { TRPCClient } from '@trpc/client';
import type { CreateTRPCReact } from '@trpc/react-query';
import { createTRPCReact, httpBatchLink } from '@trpc/react-query';
import superjson from 'superjson';
import type { AppRouter } from '../../backend/trpc';

// Re-export AppRouter type for use in frontend components
export type { AppRouter };

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Browser should use current path
    return '';
  }
  // SSR should use localhost
  return `http://localhost:${process.env.BACKEND_PORT || 3001}`;
};

/**
 * Creates a tRPC client with a context getter function.
 * The getter is called on each request to get fresh context values.
 */
export function createTrpcClient(
  getContext: () => { projectId?: string; taskId?: string }
): TRPCClient<AppRouter> {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${getBaseUrl()}/api/trpc`,
        transformer: superjson,
        headers() {
          const { projectId, taskId } = getContext();
          const headers: Record<string, string> = {};
          if (projectId) {
            headers['X-Project-Id'] = projectId;
          }
          if (taskId) {
            headers['X-Task-Id'] = taskId;
          }
          return headers;
        },
      }),
    ],
  });
}
