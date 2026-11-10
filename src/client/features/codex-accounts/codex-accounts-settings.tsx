import { useEffect, useRef, useState } from 'react';
import { Loading } from '@/client/components/loading';
import { POLL_INTERVAL_MS, QUERY_RETRY } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import type { CodexAccountSummary, CodexLoginState } from '@/shared/codex-accounts';
import { CodexAccountLoginDialog } from './codex-account-login-dialog';

interface AccountsViewProps {
  accounts?: readonly CodexAccountSummary[];
  loading?: boolean;
  error?: string;
  busy?: boolean;
  /** The account whose sign-in is starting. */
  signingInId?: string;
  /** The account whose "Use for Auto" change is saving. */
  updatingId?: string;
  onAdd: () => void;
  onLogin: (id: string) => void;
  onUpdate: (id: string, enabled: boolean) => void;
}
function AccountUsage({ usage }: { usage: CodexAccountSummary['usage'] }) {
  return usage.status === 'available' && usage.windows.length ? (
    usage.windows.map((window) => (
      <div key={window.id} className="space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <span>{window.label}</span>
          <span>{Math.round(window.usedPercent)}% used</span>
        </div>
        <Progress
          value={Math.max(0, Math.min(100, window.usedPercent))}
          aria-label={`${window.label} used`}
          className="h-1"
        />
        <p className="text-muted-foreground">
          {window.resetsAt === null
            ? 'Reset time unavailable'
            : `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}`}
        </p>
      </div>
    ))
  ) : (
    <p className="text-xs text-muted-foreground">{usage.message ?? 'Usage unavailable'}</p>
  );
}

export function CodexAccountsView({
  accounts,
  loading,
  error,
  busy,
  signingInId,
  updatingId,
  onAdd,
  onLogin,
  onUpdate,
}: AccountsViewProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Codex accounts</CardTitle>
          <Button size="sm" variant="outline" onClick={onAdd} disabled={busy || loading || !!error}>
            Add Codex account
          </Button>
        </div>
        <CardDescription>
          New chats use Auto to choose an available account. Existing chats keep their saved
          account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <Loading size="compact" message="Loading accounts…" />}
        {error && (
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        {accounts?.map((account) => (
          <div key={account.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {account.email ??
                    (account.kind === 'NATIVE_DEFAULT'
                      ? 'Current native Codex profile'
                      : 'Identity unavailable')}
                  {account.planType ? ` · ${account.planType}` : ''}
                </p>
              </div>
              {account.kind === 'MANAGED' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onLogin(account.id)}
                  disabled={busy}
                  pending={signingInId === account.id}
                >
                  {account.authenticated ? 'Sign in again' : 'Sign in'}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {account.authenticated ? 'Connected' : 'Not signed in'}
            </p>
            {account.kind === 'NATIVE_DEFAULT' && (
              <p className="text-xs text-muted-foreground">
                To reconnect this native account, run{' '}
                <code className="rounded bg-muted px-1">ff codex login</code> in your terminal.
              </p>
            )}
            <AccountUsage usage={account.usage} />
            <label className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5">
                Use for Auto
                {updatingId === account.id && <Spinner aria-hidden="true" className="size-3" />}
              </span>
              <Switch
                aria-label={`Use ${account.label} for Auto`}
                checked={account.enabled}
                disabled={busy}
                aria-busy={updatingId === account.id || undefined}
                onCheckedChange={(enabled) => onUpdate(account.id, enabled)}
              />
            </label>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Disabling Auto leaves existing chats and manual account selection available. Manage
          accounts on the local Factory Factory server.
        </p>
      </CardContent>
    </Card>
  );
}

export function CodexAccountsSettings() {
  const utils = trpc.useUtils();
  const accounts = trpc.codexAccounts.list.useQuery(undefined, {
    staleTime: 30_000,
    retry: QUERY_RETRY.costlyRead,
  });
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState<CodexLoginState>();
  const [error, setError] = useState<string>();
  const create = trpc.codexAccounts.create.useMutation({ meta: { errorToast: false } });
  const start = trpc.codexAccounts.startLogin.useMutation({ meta: { errorToast: false } });
  const cancel = trpc.codexAccounts.cancelLogin.useMutation({ meta: { errorToast: false } });
  // A login still starting when the settings close is cancelled instead of left running.
  const mounted = useRef(true);
  const activeLoginId = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeLoginId.current) {
        void cancel.mutateAsync({ id: activeLoginId.current }).catch(() => undefined);
      }
    };
  }, [cancel.mutateAsync]);
  const update = trpc.codexAccounts.update.useMutation({
    onSuccess: () => {
      setError(undefined);
      return utils.codexAccounts.list.invalidate();
    },
    onError: (error) => setError(error.message),
  });
  const status = trpc.codexAccounts.loginStatus.useQuery(
    { id: login?.accountId ?? '' },
    {
      enabled: login?.status === 'pending',
      refetchInterval: login?.status === 'pending' ? POLL_INTERVAL_MS.progress : false,
      retry: QUERY_RETRY.nextPoll,
    }
  );
  useEffect(() => {
    if (status.data && status.data.accountId === login?.accountId && login.status === 'pending') {
      setLogin(status.data);
      if (status.data.status !== 'pending') {
        activeLoginId.current = undefined;
        void utils.codexAccounts.list.invalidate();
      }
    }
  }, [status.data, login?.accountId, login?.status, utils]);
  const cancelPendingLogin = async (state: CodexLoginState) => {
    if (state.status === 'pending') {
      await cancel.mutateAsync({ id: state.accountId });
    }
  };
  const busy = create.isPending || start.isPending || cancel.isPending;
  const begin = async (id: string) => {
    setError(undefined);
    setOpen(true);
    try {
      await utils.codexAccounts.loginStatus.cancel({ id });
      if (!mounted.current) {
        return;
      }
      activeLoginId.current = id;
      const state = await start.mutateAsync({ id });
      if (!mounted.current) {
        await cancelPendingLogin(state);
        return;
      }
      activeLoginId.current = state.status === 'pending' ? id : undefined;
      utils.codexAccounts.loginStatus.setData({ id }, state);
      setLogin(state);
    } catch (error) {
      activeLoginId.current = undefined;
      if (!mounted.current) {
        return;
      }
      setLogin({
        accountId: id,
        status: 'failed',
        message: error instanceof Error ? error.message : "Couldn't start login",
      });
    }
  };
  return (
    <>
      <CodexAccountsView
        accounts={accounts.data}
        loading={accounts.isLoading}
        error={
          accounts.error
            ? 'Account management is available only from a trusted local connection.'
            : undefined
        }
        busy={busy || update.isPending || login?.status === 'pending'}
        signingInId={start.isPending ? start.variables?.id : undefined}
        updatingId={update.isPending ? update.variables?.id : undefined}
        onAdd={() => {
          setLogin(undefined);
          setError(undefined);
          setOpen(true);
        }}
        onLogin={(id) => {
          void begin(id);
        }}
        onUpdate={(id, enabled) => update.mutate({ id, enabled })}
      />
      {!open && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <CodexAccountLoginDialog
        key={open ? 'open' : 'closed'}
        open={open}
        login={login}
        busy={busy}
        error={error ?? (login?.status === 'pending' ? status.error?.message : undefined)}
        onClose={() => setOpen(false)}
        onSubmit={(label) => {
          void (async () => {
            setError(undefined);
            try {
              const account = await create.mutateAsync({ label });
              await utils.codexAccounts.list.invalidate();
              if (mounted.current) {
                await begin(account.id);
              }
            } catch (error) {
              setError(error instanceof Error ? error.message : "Couldn't add account");
            }
          })();
        }}
        onCancel={() => {
          if (login) {
            void cancel
              .mutateAsync({ id: login.accountId })
              .then((state) => {
                activeLoginId.current = undefined;
                setError(undefined);
                setLogin(state);
                void utils.codexAccounts.list.invalidate();
              })
              .catch((error) =>
                setError(error instanceof Error ? error.message : "Couldn't cancel login")
              );
          }
        }}
      />
    </>
  );
}
