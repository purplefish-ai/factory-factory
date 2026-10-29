import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import type { AgentFormValues } from './types';
import { useAgentProject } from './use-agent-project';

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not update agent. Please try again.';
}

export function useAgentsController() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'detail' | 'create' | 'edit'>('detail');
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const currentId = useRef(id);
  currentId.current = id;
  const utils = trpc.useUtils();
  const task = trpc.periodicTask.get.useQuery(
    { id: id ?? '' },
    { enabled: !!id, refetchInterval: 10_000, retry: false }
  );
  const onProjectSwitch = useCallback(() => {
    setMode('detail');
    setDeleteOpen(false);
    setActionError(null);
    void navigate('/agents');
  }, [navigate]);
  const projectState = useAgentProject(id, task.data, onProjectSwitch);
  const { project } = projectState;
  const currentProjectId = useRef(project?.id);
  currentProjectId.current = project?.id;
  const list = trpc.periodicTask.list.useQuery(
    { projectId: project?.id ?? '' },
    { enabled: !!project, refetchInterval: 10_000 }
  );
  const create = trpc.periodicTask.create.useMutation({
    onError: (error) => toast.error(`Failed to create agent: ${error.message}`),
  });
  const update = trpc.periodicTask.update.useMutation({
    onError: (error) => toast.error(`Failed to update agent: ${error.message}`),
  });
  const toggle = trpc.periodicTask.toggleEnabled.useMutation({
    onError: (error, variables) =>
      toast.error(`Failed to ${variables.enabled ? 'resume' : 'pause'} agent: ${error.message}`),
  });
  const remove = trpc.periodicTask.delete.useMutation({
    onError: (error) => toast.error(`Failed to delete agent: ${error.message}`),
  });
  const createDisabled =
    pending ||
    create.isPending ||
    update.isPending ||
    projectState.projectsLoading ||
    projectState.ownerLoading ||
    !project ||
    (!!id && (!task.data || project.id !== task.data.projectId));

  const previousId = useRef(id);
  useEffect(() => {
    if (previousId.current === id) {
      return;
    }
    previousId.current = id;
    setMode('detail');
    setDeleteOpen(false);
    setActionError(null);
  }, [id]);
  useEffect(() => {
    const first = list.data?.[0];
    if (!id && mode === 'detail' && first && !list.error) {
      void navigate(`/agents/${first.id}`, { replace: true });
    }
  }, [id, list.data, list.error, mode, navigate]);

  const invalidate = (projectId: string, agentId: string) => {
    runInBackground(
      Promise.all([
        utils.periodicTask.list.invalidate({ projectId }),
        utils.periodicTask.get.invalidate({ id: agentId }),
      ]),
      'Could not refresh agents'
    );
  };
  const save = async (values: AgentFormValues) => {
    if (!project) {
      throw new Error('Select a project before saving this agent.');
    }
    if (mode === 'create') {
      const created = await create.mutateAsync({ projectId: project.id, ...values });
      invalidate(project.id, created.id);
      if (
        currentId.current === id &&
        currentProjectId.current === project.id &&
        currentMode.current === 'create'
      ) {
        setMode('detail');
        void navigate(`/agents/${created.id}`);
      }
    } else if (id && task.data) {
      await update.mutateAsync({ id, ...values });
      invalidate(task.data.projectId, id);
      if (currentId.current === id) {
        setMode('detail');
      }
    }
  };
  const performAction = async (kind: 'toggle' | 'delete') => {
    if (!(task.data && id) || pendingRef.current) {
      return;
    }
    const target = task.data;
    const targetId = id;
    pendingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (kind === 'toggle') {
        await toggle.mutateAsync({ id: targetId, enabled: !target.isEnabled });
      } else {
        await remove.mutateAsync({ id: targetId });
      }
      if (kind === 'delete') {
        utils.periodicTask.list.setData({ projectId: target.projectId }, (agents) =>
          agents?.filter((agent) => agent.id !== targetId)
        );
      }
      invalidate(target.projectId, targetId);
      if (kind === 'delete' && currentId.current === targetId) {
        setDeleteOpen(false);
        setMode('detail');
        void navigate('/agents');
      }
    } catch (error) {
      if (currentId.current !== targetId) {
        return;
      }
      setActionError(mutationErrorMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return {
    id,
    task: { data: task.data, error: task.error, isLoading: task.isLoading, refetch: task.refetch },
    list: { data: list.data, error: list.error, isLoading: list.isLoading, refetch: list.refetch },
    ...projectState,
    mode,
    setMode,
    deleteOpen,
    setDeleteOpen,
    actionError,
    pending: pending || create.isPending || update.isPending,
    save,
    createDisabled,
    openDelete: () => {
      setActionError(null);
      setDeleteOpen(true);
    },
    selectAgent: () => {
      setMode('detail');
      setDeleteOpen(false);
      setActionError(null);
    },
    startCreate: () => {
      if (createDisabled) {
        return;
      }
      setMode('create');
      setDeleteOpen(false);
      setActionError(null);
    },
    toggle: () => {
      void performAction('toggle');
    },
    deleteAgent: () => {
      void performAction('delete');
    },
  };
}
