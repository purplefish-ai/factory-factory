import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CodexLoginState } from '@/shared/codex-accounts';

export interface CodexAccountLoginDialogProps {
  open: boolean;
  busy?: boolean;
  error?: string;
  login?: CodexLoginState;
  onSubmit: (label: string) => void;
  onCancel: () => void;
  onClose: () => void;
}
const LOGIN_STATUS_LABELS = {
  pending: 'Waiting for browser login…',
  completed: 'Account connected',
  cancelled: 'Login cancelled',
  failed: 'Login failed',
} as const;
function LoginProgress({ login }: { login: CodexLoginState }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 text-sm">
      <p>{LOGIN_STATUS_LABELS[login.status]}</p>
      {login.message && <p className="text-muted-foreground">{login.message}</p>}
      {login.status === 'pending' && login.authorizationUrl && (
        <Button asChild>
          <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">
            Open Codex login in browser
          </a>
        </Button>
      )}
      {login.status === 'pending' && (
        <p className="text-muted-foreground">Complete sign-in in the browser, then return here.</p>
      )}
    </div>
  );
}
export function CodexAccountLoginDialog({
  open,
  busy,
  error,
  login,
  onSubmit,
  onCancel,
  onClose,
}: CodexAccountLoginDialogProps) {
  const [label, setLabel] = useState('');
  const pending = login?.status === 'pending';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!(next || busy)) {
          if (pending) {
            onCancel();
          } else {
            onClose();
          }
        }
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{login ? 'Codex account login' : 'Add Codex account'}</DialogTitle>
          <DialogDescription>
            Sign in with Codex in your browser. Each added account has its own settings, plugins,
            skills and memory. Repository settings still apply.
          </DialogDescription>
        </DialogHeader>
        {!login && (
          <form
            id="codex-account-login"
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim() && !busy) {
                onSubmit(label.trim());
              }
            }}
          >
            <Label htmlFor="codex-account-name">Account name</Label>
            <Input
              id="codex-account-name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Personal or Work"
              maxLength={100}
              disabled={busy}
              autoFocus
            />
          </form>
        )}
        {login && <LoginProgress login={login} />}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {pending ? (
            <Button variant="outline" disabled={busy} onClick={onCancel}>
              Cancel login
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {login ? 'Done' : 'Cancel'}
            </Button>
          )}
          {!login && (
            <Button type="submit" form="codex-account-login" disabled={busy || !label.trim()}>
              {busy ? 'Starting login…' : 'Continue to login'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
