import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { runInBackground } from '@/client/lib/background-task';
import {
  readBrowserNotificationsEnabled,
  readNotificationPermission,
} from '@/client/lib/browser-notifications';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { playSound } from '@/client/lib/sound';
import { trpc } from '@/client/lib/trpc';
import { claimWorkspaceCompletion } from '@/client/lib/workspace-notification-claim';
import { fetchWorkspaceDetail } from '@/client/lib/workspace-queries';

const notificationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  sessionCount: z.number().int().positive(),
  finishedAt: z.iso.datetime(),
});

type NotificationRequest = z.infer<typeof notificationRequestSchema>;

function rememberCompletion(seen: Set<string>, request: NotificationRequest): boolean {
  const identity = JSON.stringify([request.workspaceId, request.finishedAt]);
  if (seen.has(identity)) {
    return false;
  }
  seen.add(identity);
  if (seen.size > 1000) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
  return true;
}

function focusApp(): void {
  window.focus();
  const focus = window.electronAPI?.focusWindow?.();
  if (focus) {
    runInBackground(focus, "Couldn't focus the app window.");
  }
}

function showDesktopNotification(request: NotificationRequest, onOpen: () => Promise<void>): void {
  if (!readBrowserNotificationsEnabled() || readNotificationPermission() !== 'granted') {
    return;
  }
  try {
    const notification = new Notification(`Workspace ready: ${request.workspaceName}`, {
      body:
        request.sessionCount === 1
          ? 'Agent finished and is ready for your attention.'
          : `All ${request.sessionCount} agents finished and are ready for your attention.`,
      icon: `${import.meta.env.BASE_URL}favicon.svg`,
      tag: `workspace-complete-${request.workspaceId}`,
      requireInteraction: false,
    });
    notification.onclick = () => {
      // Keep focus inside the OS/browser click gesture, ahead of network reads.
      notification.close();
      focusApp();
      runInBackground(onOpen(), "Couldn't open the workspace.");
    };
  } catch {
    toast.error("Couldn't show the workspace notification.");
  }
}

/** Workspace completion sound, attention and explicitly enabled desktop alerts. */
export function WorkspaceNotificationManager() {
  const { data: settings, isSuccess } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const voiceModeActiveRef = useRef(false);
  const soundEnabledRef = useRef(false);
  useEffect(() => {
    soundEnabledRef.current = isSuccess && (settings?.playSoundOnComplete ?? true);
  }, [isSuccess, settings?.playSoundOnComplete]);
  // Bound remembered completion identities while suppressing replay duplicates.
  const completedRef = useRef(new Set<string>());

  useEffect(() => {
    const onVoiceChanged = (event: Event) => {
      const parsed = z
        .object({ active: z.boolean() })
        .safeParse(event instanceof CustomEvent ? event.detail : undefined);
      if (parsed.success) {
        voiceModeActiveRef.current = parsed.data.active;
      }
    };
    window.addEventListener('voice-mode-changed', onVoiceChanged);
    return () => window.removeEventListener('voice-mode-changed', onVoiceChanged);
  }, []);

  useEffect(() => {
    let active = true;
    const openWorkspace = async (workspaceId: string) => {
      const workspace = await fetchWorkspaceDetail(queryClient, utils.client, workspaceId);
      const project = await utils.project.getById.fetch({ id: workspace.projectId });
      if (!project) {
        throw new Error('The workspace project is no longer available.');
      }
      await navigate(
        `${getProjectSectionPath(project.slug, 'workspaces')}/${encodeURIComponent(workspace.id)}`
      );
    };
    const deliverCompletion = async (request: NotificationRequest) => {
      const canChime = () => soundEnabledRef.current && !voiceModeActiveRef.current;
      const desktopEnabled =
        readBrowserNotificationsEnabled() && readNotificationPermission() === 'granted';
      if (!(canChime() || desktopEnabled)) {
        return;
      }
      if (!((await claimWorkspaceCompletion(request, () => active)) && active)) {
        return;
      }
      if (canChime()) {
        playSound('sounds/workspace-complete.mp3', { volume: 0.5 });
      }
      showDesktopNotification(request, () => openWorkspace(request.workspaceId));
    };
    const onCompletion = (event: Event) => {
      const parsed = notificationRequestSchema.safeParse(
        event instanceof CustomEvent ? event.detail : undefined
      );
      if (!parsed.success) {
        return;
      }
      const { workspaceId } = parsed.data;
      if (!rememberCompletion(completedRef.current, parsed.data)) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent('workspace-attention-required', { detail: { workspaceId } })
      );
      runInBackground(
        deliverCompletion(parsed.data),
        "Couldn't deliver the workspace notification."
      );
    };
    window.addEventListener('workspace-notification-request', onCompletion);
    return () => {
      active = false;
      window.removeEventListener('workspace-notification-request', onCompletion);
    };
  }, [utils, queryClient, navigate]);
  return null;
}
