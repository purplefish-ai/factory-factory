import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { RatchetWrenchIcon } from '@/client/features/workspace';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export function RatchetSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Ratchet settings updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const triggerRatchetCheck = trpc.admin.triggerRatchetCheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Ratchet check completed: ${result.checked} checked, ${result.stateChanges} state changes, ${result.actionsTriggered} actions triggered`
      );
    },
    onError: (error) => {
      toast.error(`Failed to trigger ratchet check: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
            Ratchet Pull Requests
          </CardTitle>
          <CardDescription>
            Automatically dispatch agents to fix CI failures and address code review comments
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentRatchetPermissions = settings?.ratchetPermissions ?? 'YOLO';
  const currentReviewTriggerMode = settings?.ratchetReviewTriggerMode ?? 'CHANGES_REQUESTED';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
          Ratchet Pull Requests
        </CardTitle>
        <CardDescription>
          Automatically dispatch agents to fix CI failures and address code review comments
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
          <p className="text-sm text-muted-foreground">
            When a workspace has an open pull request, Factory Factory can automatically:
          </p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-2">
            <li>Fix failing CI checks</li>
            <li>Address code review comments</li>
          </ul>
        </div>

        {/* Default for new workspaces */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="ratchet-enabled">Default for new workspaces</Label>
            <p className="text-sm text-muted-foreground">
              Enable Ratchet for workspaces created from GitHub issues
            </p>
          </div>
          <Switch
            id="ratchet-enabled"
            checked={settings?.ratchetEnabled ?? false}
            onCheckedChange={(checked) => {
              updateSettings.mutate({ ratchetEnabled: checked });
            }}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ratchet-review-trigger">Review feedback trigger</Label>
          <Select
            value={currentReviewTriggerMode}
            onValueChange={(value) => {
              if (value === 'CHANGES_REQUESTED' || value === 'ALL_REVIEW_FEEDBACK') {
                updateSettings.mutate({ ratchetReviewTriggerMode: value });
              }
            }}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="ratchet-review-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CHANGES_REQUESTED">
                Changes requested and unresolved threads
              </SelectItem>
              <SelectItem value="ALL_REVIEW_FEEDBACK">All review feedback</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            All review feedback also lets top-level commented review summaries start sessions.
            Ordinary PR conversation comments never trigger Ratchet.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ratchet-permissions">Ratchet permission defaults</Label>
          <Select
            value={currentRatchetPermissions}
            onValueChange={(value) => {
              if (value === 'STRICT' || value === 'RELAXED' || value === 'YOLO') {
                updateSettings.mutate({ ratchetPermissions: value });
              }
            }}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="ratchet-permissions">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="STRICT">Strict</SelectItem>
              <SelectItem value="RELAXED">Relaxed</SelectItem>
              <SelectItem value="YOLO">YOLO</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Controls the default execution mode used when Ratchet starts a fixer session.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="ratchet-reply-to-pr-comments">Reply to PR comments</Label>
            <p className="text-sm text-muted-foreground">
              When enabled, Ratchet replies on review threads and posts a re-review PR comment
            </p>
          </div>
          <Switch
            id="ratchet-reply-to-pr-comments"
            checked={settings?.ratchetReplyToPrComments ?? true}
            onCheckedChange={(checked) => {
              updateSettings.mutate({ ratchetReplyToPrComments: checked });
            }}
            disabled={updateSettings.isPending}
          />
        </div>

        {/* Manual trigger button */}
        <div className="border-t pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label>Manual Check</Label>
              <p className="text-sm text-muted-foreground">
                Check all workspaces with PRs and dispatch agents if needed
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerRatchetCheck.mutate()}
              disabled={triggerRatchetCheck.isPending}
            >
              {triggerRatchetCheck.isPending ? (
                <>
                  <ArrowsClockwiseIcon className="w-4 h-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <ArrowsClockwiseIcon className="w-4 h-4 mr-2" />
                  Check All PRs Now
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
