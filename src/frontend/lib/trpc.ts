'use client';

import type { CreateTRPCReact } from '@trpc/react-query';
import { createTRPCReact, httpBatchLink } from '@trpc/react-query';
import superjson from 'superjson';
import type { AppRouter } from '../../backend/trpc';

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Browser should use current path
    return '';
  }
  // SSR should use localhost
  return `http://localhost:${process.env.BACKEND_PORT || 3001}`;
};

/**
 * Global store for project context.
 * Set via setProjectContext() and automatically included in tRPC request headers.
 */
let currentProjectId: string | undefined;
let currentEpicId: string | undefined;

export function setProjectContext(projectId?: string, epicId?: string) {
  currentProjectId = projectId;
  currentEpicId = epicId;
}

export function getProjectContext() {
  return { projectId: currentProjectId, epicId: currentEpicId };
}

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${getBaseUrl()}/api/trpc`,
      transformer: superjson,
      headers() {
        const headers: Record<string, string> = {};
        if (currentProjectId) {
          headers['X-Project-Id'] = currentProjectId;
        }
        if (currentEpicId) {
          headers['X-Epic-Id'] = currentEpicId;
        }
        return headers;
      },
    }),
  ],
});
