import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { invalidateAgentProjectQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import {
  getProjectAgentPath,
  getProjectSectionPath,
  type AgentKind,
} from '@/client/lib/project-navigation';
import { trpc } from '@/client/lib/trpc';
import type { AgentFormValues, AgentProject } from './types';

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not update agent. Please try again.';
}

export function useAgentsController(project: AgentProject, kind: AgentKind = 'scheduled') {
  const location = useLocation();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'detail' | 'create' | 'edit'>(
    location.state?.createAgent === true ? 'create' : 'detail'
  );
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
    { enabled: !!id && kind === 'scheduled', refetchInterval: 10_000, retry: false }
  );
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  const list = trpc.periodicTask.list.useQuery(
    { projectId: project.id },
    { refetchInterval: 10_000 }
  );
  const events = trpc.agent.list.useInfiniteQuery(
    { projectId: project.id },
    {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: 10_000,
      retry: false,
    }
  );
  const event = trpc.agent.get.useQuery(
    { projectId: project.id, agentId: id ?? '' },
    { enabled: !!id && kind === 'event', refetchInterval: 10_000, retry: false }
  );
  const [savedEvent, setSavedEvent] = useState(false);
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
    !!project.isArchived ||
    (!!id &&
      (kind === 'scheduled' ? !task.data || project.id !== task.data.projectId : !event.data));

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
    if (
      id ||
      mode !== 'detail' ||
      !list.isSuccess ||
      !events.isSuccess ||
      list.error ||
      events.error
    ) {
      return;
    }
    const scheduled = list.data?.[0];
    const first = scheduled ?? events.data?.pages[0]?.items[0];
    if (first) {
      void navigate(
        getProjectAgentPath(project.slug, first.id, scheduled ? 'scheduled' : 'event'),
        { replace: true }
      );
    }
  }, [
    id,
    list.data,
    list.isSuccess,
    list.error,
    events.data,
    events.isSuccess,
    events.error,
    mode,
    navigate,
    project.slug,
  ]);

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
    } else if (kind === 'scheduled' && id && task.data?.projectId === project.id) {
      await update.mutateAsync({ id, ...values });
      invalidate(task.data.projectId, id);
      if (
        active.current &&
        currentId.current === id &&
        currentProjectId.current === project.id &&
        currentMode.current === 'edit'
      ) {
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
  const performAction = async (operation: 'toggle' | 'delete') => {
    if (
      kind !== 'scheduled' ||
      project.isArchived ||
      !(task.data && id) ||
      task.data.projectId !== project.id ||
      pendingRef.current
    ) {
      return;
    }
    const target = task.data;
    const targetId = id;
    pendingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (operation === 'toggle') {
        await toggle.mutateAsync({ id: targetId, enabled: !target.isEnabled });
      } else {
        await remove.mutateAsync({ id: targetId });
      }
      if (operation === 'delete') {
        utils.periodicTask.list.setData({ projectId: target.projectId }, (agents) =>
          agents?.filter((agent) => agent.id !== targetId)
        );
      }
      invalidate(target.projectId, targetId);
      if (active.current && operation === 'delete' && currentId.current === targetId) {
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
    kind,
    events: {
      data: events.data,
      error: events.error,
      isLoading: events.isLoading,
      hasNextPage: events.hasNextPage,
      isFetchingNextPage: events.isFetchingNextPage,
      fetchNextPage: () => {
        void events.fetchNextPage();
      },
      refetch: () => {
        void events.refetch();
      },
    },
    event: {
      data: event.data,
      error: event.error,
      isLoading: event.isLoading,
      refetch: () => {
        void event.refetch();
      },
    },
    savedEvent,
    eventSaved: () => {
      setSavedEvent(true);
      setMode('detail');
    },
    task: { data: task.data, error: task.error, isLoading: task.isLoading, refetch: task.refetch },
    list: { data: list.data, error: list.error, isLoading: list.isLoading, refetch: list.refetch },
    project,
    wrongOwner: kind === 'scheduled' && !!task.data && task.data.projectId !== project.id,
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
      if (kind === 'event') {
        void navigate(getProjectSectionPath(project.slug, 'agents'), {
          state: { createAgent: true },
        });
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
