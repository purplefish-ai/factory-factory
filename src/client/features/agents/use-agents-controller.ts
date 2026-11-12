import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import { invalidateAgentProjectQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import {
  getProjectAgentPath,
  getProjectSectionPath,
  type AgentKind,
} from '@/client/lib/project-navigation';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import type { AgentFormValues, AgentProject, AgentListItem, EventAgentSummary } from './types';

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Please try again.';
}

type AgentAction = 'toggle' | 'delete';

function actionVerb(operation: AgentAction, enabled: boolean): string {
  if (operation === 'delete') {
    return 'delete';
  }
  return enabled ? 'pause' : 'resume';
}

function initialAgentSelection(
  kind: AgentKind,
  scheduled: { isSuccess: boolean; error: unknown; data?: AgentListItem[] },
  events: { isSuccess: boolean; error: unknown; data?: { pages: { items: EventAgentSummary[] }[] } }
): { id: string; kind: AgentKind } | undefined {
  if (!events.isSuccess || events.error) {
    return;
  }
  const event = events.data?.pages[0]?.items[0];
  if (kind === 'event') {
    return event ? { id: event.id, kind: 'event' } : undefined;
  }
  if (!scheduled.isSuccess || scheduled.error) {
    return;
  }
  const task = scheduled.data?.[0];
  if (task) {
    return { id: task.id, kind: 'scheduled' };
  }
  return event ? { id: event.id, kind: 'event' } : undefined;
}

export function useAgentsController(project: AgentProject, kind: AgentKind = 'scheduled') {
  const location = useLocation();
  // Decides whether a finished action may navigate or must toast instead.
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'detail' | 'create' | 'create-event' | 'edit'>(
    location.state?.createAgent === true ? 'create' : 'detail'
  );
  const currentMode = useLatestRef(mode);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Selecting another agent closes the editor, delete dialog and action error.
  const [stateAgentId, setStateAgentId] = useState(id);
  if (stateAgentId !== id) {
    setStateAgentId(id);
    setMode('detail');
    setDeleteOpen(false);
    setActionError(null);
  }
  // Covers the whole action (mutation, cache update, navigation) and blocks a
  // second click before the mutation's pending state reaches React.
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const pendingRef = useRef(false);
  const currentId = useLatestRef(id);
  const utils = trpc.useUtils();
  const task = trpc.periodicTask.get.useQuery(
    { id: id ?? '' },
    { enabled: !!id && kind === 'scheduled', refetchInterval: POLL_INTERVAL_MS.activity }
  );
  const currentProjectId = useLatestRef(project.id);
  const list = trpc.periodicTask.list.useQuery(
    { projectId: project.id },
    { refetchInterval: POLL_INTERVAL_MS.activity }
  );
  const events = trpc.automation.list.useInfiniteQuery(
    { projectId: project.id },
    {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: POLL_INTERVAL_MS.activity,
    }
  );
  const event = trpc.automation.get.useQuery(
    { projectId: project.id, agentId: id ?? '' },
    { enabled: !!id && kind === 'event', refetchInterval: POLL_INTERVAL_MS.activity }
  );
  const [savedEvent, setSavedEvent] = useState(false);
  // Failures show inline: the form keeps its draft beside the error, and the
  // detail view and delete dialog show action errors. A toast reports only a
  // failure whose editor or agent is no longer on screen.
  const create = trpc.periodicTask.create.useMutation({ meta: { errorToast: false } });
  const update = trpc.periodicTask.update.useMutation({ meta: { errorToast: false } });
  const toggle = trpc.periodicTask.toggleEnabled.useMutation({ meta: { errorToast: false } });
  const remove = trpc.periodicTask.delete.useMutation({ meta: { errorToast: false } });
  const createDisabled =
    pendingAction !== null ||
    create.isPending ||
    update.isPending ||
    !!project.isArchived ||
    (!!id &&
      (kind === 'scheduled' ? !task.data || project.id !== task.data.projectId : !event.data));

  useEffect(() => {
    if (id || mode !== 'detail') {
      return;
    }
    const first = initialAgentSelection(
      kind,
      { data: list.data, isSuccess: list.isSuccess, error: list.error },
      { data: events.data, isSuccess: events.isSuccess, error: events.error }
    );
    if (first) {
      void navigate(getProjectAgentPath(project.slug, first.id, first.kind), { replace: true });
    }
  }, [
    id,
    kind,
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
      "Couldn't refresh automations."
    );
  };
  const isCurrentEditor = (editMode: 'create' | 'edit') =>
    active.current &&
    currentId.current === id &&
    currentProjectId.current === project.id &&
    currentMode.current === editMode;
  const save = async (values: AgentFormValues) => {
    const editMode = mode === 'create' ? 'create' : 'edit';
    try {
      await saveValues(values);
    } catch (error) {
      if (!isCurrentEditor(editMode)) {
        toast.error(
          `Couldn't ${editMode === 'create' ? 'create' : 'update'} automation. ${mutationErrorMessage(error)}`
        );
      }
      throw error;
    }
  };
  const saveValues = async (values: AgentFormValues) => {
    if (mode === 'create') {
      const created = await create.mutateAsync({ projectId: project.id, ...values });
      invalidate(project.id, created.id);
      if (isCurrentEditor('create')) {
        void navigate(getProjectAgentPath(project.slug, created.id), {
          replace: location.state?.createAgent === true,
        });
      }
    } else if (kind === 'scheduled' && id && task.data?.projectId === project.id) {
      await update.mutateAsync({ id, ...values });
      invalidate(task.data.projectId, id);
      if (isCurrentEditor('edit')) {
        setMode('detail');
      }
    }
  };
  const finishAction = () => {
    pendingRef.current = false;
    setPendingAction(null);
  };
  const reportActionError = (verb: string, targetId: string, error: unknown) => {
    const message = `Couldn't ${verb} automation. ${mutationErrorMessage(error)}`;
    if (active.current && currentId.current === targetId) {
      setActionError(message);
    } else {
      toast.error(message);
    }
  };
  const performAction = async (operation: AgentAction) => {
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
    setPendingAction(operation);
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
      reportActionError(actionVerb(operation, target.isEnabled), targetId, error);
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
    /** Drops a deleted event automation from the list and leaves its detail, if still shown. */
    eventDeleted: (agentId: string) => {
      utils.automation.list.setInfiniteData({ projectId: project.id }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== agentId),
              })),
            }
          : data
      );
      if (active.current && currentId.current === agentId) {
        setMode('detail');
        setSavedEvent(false);
        void navigate(`${getProjectSectionPath(project.slug, 'agents')}?kind=event`);
      }
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
    pending: pendingAction !== null || create.isPending || update.isPending,
    pendingAction,
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
    startCreate: (createKind: AgentKind) => {
      if (createDisabled) {
        return;
      }
      if (createKind === 'event') {
        setMode('create-event');
        setDeleteOpen(false);
        setActionError(null);
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
