'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createTrpcClient, trpc } from './trpc';

type ProjectContextValue = {
  projectId: string | undefined;
  taskId: string | undefined;
  setProjectContext: (projectId?: string, taskId?: string) => void;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProjectContext must be used within TRPCProvider');
  }
  return ctx;
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 1000, // 5 seconds
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  // Use refs for context values to avoid recreating the tRPC client
  const projectIdRef = useRef<string | undefined>(undefined);
  const taskIdRef = useRef<string | undefined>(undefined);

  // State to trigger re-renders when context changes (for consumers)
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [taskId, setTaskId] = useState<string | undefined>(undefined);

  const setProjectContext = useCallback((newProjectId?: string, newTaskId?: string) => {
    projectIdRef.current = newProjectId;
    taskIdRef.current = newTaskId;
    setProjectId(newProjectId);
    setTaskId(newTaskId);
  }, []);

  // Create tRPC client once per provider instance
  // The getter reads from refs so it always gets fresh values
  const [trpcClient] = useState(() =>
    createTrpcClient(() => ({
      projectId: projectIdRef.current,
      taskId: taskIdRef.current,
    }))
  );

  const contextValue = useMemo(
    () => ({ projectId, taskId, setProjectContext }),
    [projectId, taskId, setProjectContext]
  );

  return (
    <ProjectContext.Provider value={contextValue}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </ProjectContext.Provider>
  );
}
