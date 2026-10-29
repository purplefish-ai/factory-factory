import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { invalidateAgentProjectQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { getProjectAgentPath, getProjectSectionPath } from '@/client/lib/project-navigation';
import { trpc } from '@/client/lib/trpc';
import type { AgentFormValues, AgentProject } from './types';

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not update agent. Please try again.';
}

export function useAgentsController(project: AgentProject) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
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
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  const list = trpc.periodicTask.list.useQuery(
    { projectId: project.id },
    { refetchInterval: 10_000 }
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
      void navigate(getProjectAgentPath(project.slug, first.id), { replace: true });
    }
  }, [id, list.data, list.error, mode, navigate, project.slug]);

  const invalidate = (projectId: string, agentId: string) => {
    runInBackground(
      Promise.all([
        invalidateAgentProjectQueries(utils, projectId),
        utils.periodicTask.get.invalidate({ id: agentId }),
      ]),
      'Could not refresh agents'
    );
  };
  const save = async (values: AgentFormValues) => {
    if (mode === 'create') {
      const created = await create.mutateAsync({ projectId: project.id, ...values });
      invalidate(project.id, created.id);
      if (
        active.current &&
        currentId.current === id &&
        currentProjectId.current === project.id &&
        currentMode.current === 'create'
      ) {
        setMode('detail');
        void navigate(getProjectAgentPath(project.slug, created.id));
      }
    } else if (id && task.data?.projectId === project.id) {
      await update.mutateAsync({ id, ...values });
      invalidate(task.data.projectId, id);
      if (active.current && currentId.current === id) {
        setMode('detail');
      }
    }
  };
  const finishAction = () => {
    pendingRef.current = false;
    if (active.current) {
      setPending(false);
    }
  };
  const performAction = async (kind: 'toggle' | 'delete') => {
    if (!(task.data && id) || task.data.projectId !== project.id || pendingRef.current) {
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
      if (active.current && kind === 'delete' && currentId.current === targetId) {
        setDeleteOpen(false);
        setMode('detail');
        void navigate(getProjectSectionPath(project.slug, 'agents'));
      }
    } catch (error) {
      if (!active.current || currentId.current !== targetId) {
        return;
      }
      setActionError(mutationErrorMessage(error));
    } finally {
      finishAction();
    }
  };

  return {
    id,
    task: { data: task.data, error: task.error, isLoading: task.isLoading, refetch: task.refetch },
    list: { data: list.data, error: list.error, isLoading: list.isLoading, refetch: list.refetch },
    project,
    wrongOwner: !!task.data && task.data.projectId !== project.id,
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
