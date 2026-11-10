import { ArrowCircleUpIcon } from '@phosphor-icons/react/dist/csr/ArrowCircleUp';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useEffect, useId, useState } from 'react';
import { POLL_INTERVAL_MS, QUERY_RETRY } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ApplicationUpdates, ApplicationUpdateStatus } from '@/shared/application-updates';

const STORAGE_PREFIX = 'ff_update_dismissed:';
const LEGACY_FACTORY_DISMISSAL_KEY = 'ff_dismissed_factory_release';
const PENDING_TARGET_KEY = 'ff_update_pending_target';
const RELOADED_TARGET_KEY = 'ff_update_reloaded_target';
const reloadedWithoutStorage = new Set<string>();

function readStorage(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: 'localStorage' | 'sessionStorage', key: string, value: string) {
  try {
    window[kind].setItem(key, value);
  } catch {
    // Updates and dismissal remain usable when browser storage is unavailable.
  }
}

function removeStorage(kind: 'localStorage' | 'sessionStorage', key: string) {
  try {
    window[kind].removeItem(key);
  } catch {
    // A previous dismissal must not prevent another update attempt.
  }
}

function resetUpdateReload(targetVersion: string) {
  reloadedWithoutStorage.delete(targetVersion);
  if (readStorage('sessionStorage', RELOADED_TARGET_KEY) === targetVersion) {
    removeStorage('sessionStorage', RELOADED_TARGET_KEY);
  }
}

export function claimUpdateReload(currentVersion: string, targetVersion: string): boolean {
  if (currentVersion !== targetVersion) {
    resetUpdateReload(targetVersion);
    return false;
  }
  if (reloadedWithoutStorage.has(targetVersion)) {
    return false;
  }
  if (readStorage('sessionStorage', RELOADED_TARGET_KEY) === targetVersion) {
    return false;
  }
  writeStorage('sessionStorage', RELOADED_TARGET_KEY, targetVersion);
  if (readStorage('sessionStorage', RELOADED_TARGET_KEY) !== targetVersion) {
    return false;
  }
  reloadedWithoutStorage.add(targetVersion);
  return true;
}

function dismissalKey(id: string, version: string): string {
  return `${STORAGE_PREFIX}${id}:${version}`;
}

function isActive(status: ApplicationUpdateStatus): boolean {
  return ['waiting', 'preparing', 'restarting'].includes(status.phase);
}

interface Props {
  updates: ApplicationUpdates;
  isPending?: boolean;
  onUpdate: () => void;
  onCancel: () => void;
  onDismiss: (id: string, version: string) => void;
}

function UpdateActions({ updates, isPending, onUpdate, onCancel, onDismiss }: Props) {
  const { status, automaticUpdate } = updates;
  const active = isActive(status);
  const progressLabel = status.phase === 'restarting' ? 'Restarting…' : 'Updating…';
  const updateLabel = status.phase === 'failed' ? 'Retry update' : 'Update';
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {active && <Spinner className="size-3.5" aria-hidden="true" />}
      {status.phase === 'waiting' ? (
        <Button variant="ghost" size="sm" disabled={isPending} onClick={onCancel}>
          Cancel update
        </Button>
      ) : active ? (
        <Button variant="ghost" size="sm" disabled>
          {progressLabel}
        </Button>
      ) : automaticUpdate ? (
        <Button variant="outline" size="sm" disabled={isPending} onClick={onUpdate}>
          {isPending && <Spinner className="size-3.5" aria-hidden="true" />}
          {updateLabel}
        </Button>
      ) : null}
      {status.phase === 'failed' && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss update error"
          onClick={() => onDismiss('update-error', status.targetVersion ?? updates.currentVersion)}
        >
          <XIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function FactoryUpdateBannerContent({
  updates,
  isPending = false,
  onUpdate,
  onCancel,
  onDismiss,
}: Props) {
  const { notices, status, automaticUpdate, manualCommand } = updates;
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionsId = useId();
  const active = isActive(status);
  if (notices.length === 0 && !active && status.phase !== 'failed') {
    return null;
  }
  const progress = {
    idle: '',
    waiting: 'Waiting for active agent work to finish before updating.',
    preparing: 'Preparing the update. Factory Factory will restart shortly.',
    restarting: 'Restarting Factory Factory. Reconnecting automatically…',
    failed: status.error?.slice(0, 240) || 'The update could not finish. Please try again.',
  }[status.phase];

  return (
    <section
      aria-label="Application updates"
      className="shrink-0 border-b border-primary/15 bg-primary/5 px-3 py-2 sm:px-4"
    >
      <ul className="space-y-2">
        {notices.map((notice, index) => (
          <li key={notice.id} className="flex items-start gap-2.5 text-xs">
            <ArrowCircleUpIcon className="mt-1.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-0.5 [overflow-wrap:anywhere]">
              <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
                <p className="font-medium">{notice.label} update available</p>
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                  <span className="text-muted-foreground">{notice.currentVersion}</span>
                  <span className="text-muted-foreground" aria-hidden="true">
                    →
                  </span>
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                    {notice.latestVersion}
                  </span>
                </span>
                {index === 0 && !(active || automaticUpdate) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                    aria-expanded={showInstructions}
                    aria-controls={showInstructions ? instructionsId : undefined}
                    onClick={() => setShowInstructions((previous) => !previous)}
                  >
                    How to update
                    <CaretDownIcon
                      className={`size-3 transition-transform ${showInstructions ? 'rotate-180' : ''}`}
                    />
                  </Button>
                )}
              </div>
              {notice.id !== 'factory-factory' && (
                <p className="text-muted-foreground">Updates with Factory Factory.</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDismiss(notice.id, notice.latestVersion)}
              className="shrink-0 text-muted-foreground"
              aria-label={`Dismiss ${notice.label} update`}
            >
              <XIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      {showInstructions && !(active || automaticUpdate) && (
        <div
          id={instructionsId}
          className="ml-6.5 mt-2 space-y-2 rounded-md border border-border/60 bg-background/60 px-3 py-2.5 text-xs"
        >
          <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
            {manualCommand}
          </p>
          <p className="text-muted-foreground">
            A restart is required after updating. This stops terminals and run scripts.
          </p>
        </div>
      )}
      {(progress || active || automaticUpdate) && (
        <div className="ml-6.5 mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <div className="min-w-0 flex-1 basis-full space-y-1 sm:basis-0">
            {progress && (
              <p
                role={status.phase === 'failed' ? 'alert' : 'status'}
                className={status.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
              >
                {progress}
              </p>
            )}
            {!active && automaticUpdate && (
              <p className="text-muted-foreground">
                Waits for active agent work to finish. Restart stops terminals and run scripts.
              </p>
            )}
          </div>
          <UpdateActions
            updates={updates}
            isPending={isPending}
            onUpdate={onUpdate}
            onCancel={onCancel}
            onDismiss={onDismiss}
          />
        </div>
      )}
    </section>
  );
}

export function FactoryUpdateBanner() {
  const [lastConfirmed, setLastConfirmed] = useState<ApplicationUpdates>();
  const [localStatus, setLocalStatus] = useState<ApplicationUpdateStatus>();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const query = trpc.admin.checkUpdates.useQuery(undefined, {
    retry: QUERY_RETRY.costlyRead,
    refetchInterval: (state) =>
      isActive(
        localStatus ?? state.state.data?.status ?? lastConfirmed?.status ?? { phase: 'idle' }
      )
        ? POLL_INTERVAL_MS.localStatus
        : POLL_INTERVAL_MS.releaseCheck,
  });
  const confirmed = query.data ?? lastConfirmed;
  const acceptStatus = (status: ApplicationUpdateStatus) => {
    setLocalStatus(status);
    if (status.targetVersion && isActive(status)) {
      writeStorage('sessionStorage', PENDING_TARGET_KEY, status.targetVersion);
    } else if (status.phase === 'idle') {
      removeStorage('sessionStorage', PENDING_TARGET_KEY);
    }
    void query.refetch();
  };
  const reportError = (error: { message: string }) => {
    setLocalStatus({
      phase: 'failed',
      targetVersion:
        localStatus?.targetVersion ??
        confirmed?.status.targetVersion ??
        confirmed?.notices.find((notice) => notice.id === 'factory-factory')?.latestVersion,
      error: error.message,
    });
  };
  const request = trpc.admin.requestUpdate.useMutation({
    onSuccess: acceptStatus,
    onError: reportError,
  });
  const cancel = trpc.admin.cancelUpdate.useMutation({
    onSuccess: acceptStatus,
    onError: reportError,
  });

  useEffect(() => {
    if (!query.data) {
      return;
    }
    setLastConfirmed(query.data);
    setLocalStatus(undefined);
    const { status, currentVersion } = query.data;
    if (status.targetVersion && isActive(status)) {
      writeStorage('sessionStorage', PENDING_TARGET_KEY, status.targetVersion);
    }
    const target = readStorage('sessionStorage', PENDING_TARGET_KEY);
    if (target && claimUpdateReload(currentVersion, target)) {
      window.location.reload();
    }
  }, [query.data]);

  if (!confirmed) {
    return null;
  }
  const isDismissed = (id: string, version: string) => {
    const key = dismissalKey(id, version);
    return (
      dismissed.has(key) ||
      readStorage('localStorage', key) === '1' ||
      (id === 'factory-factory' &&
        readStorage('localStorage', LEGACY_FACTORY_DISMISSAL_KEY) === version)
    );
  };
  const status = localStatus ?? confirmed.status;
  const updates = {
    ...confirmed,
    notices: confirmed.notices.filter((notice) => !isDismissed(notice.id, notice.latestVersion)),
    status:
      status.phase === 'failed' &&
      isDismissed('update-error', status.targetVersion ?? confirmed.currentVersion)
        ? { phase: 'idle' as const }
        : status,
  };
  return (
    <FactoryUpdateBannerContent
      updates={updates}
      isPending={request.isPending || cancel.isPending}
      onUpdate={() => {
        const version =
          confirmed.notices.find((notice) => notice.id === 'factory-factory')?.latestVersion ??
          status.targetVersion;
        if (version) {
          resetUpdateReload(version);
          const errorKey = dismissalKey('update-error', version);
          removeStorage('localStorage', errorKey);
          setDismissed((previous) => new Set([...previous].filter((key) => key !== errorKey)));
          request.mutate({ version });
        }
      }}
      onCancel={() => cancel.mutate()}
      onDismiss={(id, version) => {
        const key = dismissalKey(id, version);
        writeStorage('localStorage', key, '1');
        setDismissed((previous) => new Set([...previous, key]));
      }}
    />
  );
}
