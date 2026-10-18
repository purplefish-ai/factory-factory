import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { toast } from 'sonner';
import { RatchetWrenchIcon } from '@/client/features/workspace';
import { runInBackground } from '@/client/lib/background-task';
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
      toast.success('Settings updated');
      runInBackground(utils.userSettings.get.invalidate(), 'Could not refresh data');
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const triggerRatchetCheck = trpc.admin.triggerRatchetCheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `PR check completed: ${result.checked} checked, ${result.stateChanges} state changes, ${result.actionsTriggered} updates queued`
      );
    },
    onError: (error) => {
      toast.error(`Failed to check PR updates: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
            PR updates
          </CardTitle>
          <CardDescription>
            Queue CI, review and merge-conflict updates in the main conversation for its next turn
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentRatchetPermissions = settings?.autoIterationPermissions ?? 'YOLO';
  const currentReviewTriggerMode = settings?.ratchetReviewTriggerMode ?? 'CHANGES_REQUESTED';

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
            PR updates
          </CardTitle>
          <CardDescription>
            Queue CI, review and merge-conflict updates in the main conversation for its next turn
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
            <p className="text-sm text-muted-foreground">
              When a workspace has an open pull request, Factory Factory can automatically:
            </p>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-2">
              <li>Queue failing CI checks for the next turn</li>
              <li>Queue actionable code review feedback</li>
            </ul>
          </div>

          {/* Default for new workspaces */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ratchet-enabled">Default for new workspaces</Label>
              <p className="text-sm text-muted-foreground">
                Enable PR updates for workspaces created from GitHub issues
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
              All review feedback also lets top-level commented review summaries queue updates.
              Ordinary PR conversation comments do not queue updates.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ratchet-reply-to-pr-comments">Reply to PR comments</Label>
              <p className="text-sm text-muted-foreground">
                Allow the main session to reply on review threads when it addresses feedback
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
                  Check monitored PRs and queue actionable updates
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
      <Card>
        <CardHeader>
          <CardTitle>Auto-iteration</CardTitle>
          <CardDescription>Permission defaults for auto-iteration sessions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="auto-iteration-permissions">Auto-iteration permission defaults</Label>
            <Select
              value={currentRatchetPermissions}
              onValueChange={(value) => {
                if (value === 'STRICT' || value === 'RELAXED' || value === 'YOLO') {
                  updateSettings.mutate({ autoIterationPermissions: value });
                }
              }}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="auto-iteration-permissions">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="STRICT">Standard</SelectItem>
                <SelectItem value="RELAXED">Accept edits / Auto review</SelectItem>
                <SelectItem value="YOLO">Full access</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Uses each provider’s native access mode. Standard uses Claude approval prompts and
              Codex workspace access; Accept edits / Auto review uses Claude edit approval and Codex
              auto review. Full access skips prompts. PR updates inherit the main conversation’s
              settings.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
