import { GitBranch, List, Plus } from 'lucide-react';
import { useState } from 'react';
import { ChatInput } from '@/components/chat';
import { ProjectRepoForm } from '@/components/project/project-repo-form';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PageHeader } from '@/frontend/components/page-header';
import { PRDetailPanel } from '@/frontend/components/pr-detail-panel';
import { PRInboxItem } from '@/frontend/components/pr-inbox-item';
import type { ChatSettings, TokenStats } from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { PRWithFullDetails } from '@/shared/github-types';

const mobileBaselinePRs: PRWithFullDetails[] = [
  {
    number: 101,
    title: 'Fix mobile workspace sheet interactions',
    url: 'https://github.com/example/repo/pull/101',
    author: { login: 'alice' },
    repository: { name: 'repo', nameWithOwner: 'example/repo' },
    createdAt: '2026-01-10T12:00:00.000Z',
    updatedAt: '2026-01-10T13:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: null,
    reviews: [
      {
        id: 'r-1',
        author: { login: 'reviewer' },
        state: 'COMMENTED',
        submittedAt: '2026-01-10T13:15:00.000Z',
      },
    ],
    comments: [
      {
        id: 'c-1',
        author: { login: 'reviewer' },
        body: 'Please validate on iPhone SE and Pixel widths.',
        createdAt: '2026-01-10T13:20:00.000Z',
        updatedAt: '2026-01-10T13:20:00.000Z',
        url: 'https://github.com/example/repo/pull/101#discussion_r1',
      },
    ],
    labels: [{ name: 'mobile', color: '1d76db' }],
    additions: 42,
    deletions: 12,
    changedFiles: 7,
    headRefName: 'feature/mobile-layout',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
  },
  {
    number: 102,
    title: 'Improve chat input responsive controls',
    url: 'https://github.com/example/repo/pull/102',
    author: { login: 'bob' },
    repository: { name: 'repo', nameWithOwner: 'example/repo' },
    createdAt: '2026-01-11T08:00:00.000Z',
    updatedAt: '2026-01-11T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: null,
    reviews: [],
    comments: [],
    labels: [{ name: 'ux', color: '0e8a16' }],
    additions: 28,
    deletions: 9,
    changedFiles: 4,
    headRefName: 'feature/chat-mobile',
    baseRefName: 'main',
    mergeStateStatus: 'BLOCKED',
  },
];

const mobileBaselineCapabilities: ChatBarCapabilities = {
  provider: 'CLAUDE',
  model: {
    enabled: true,
    selected: 'sonnet',
    options: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ],
  },
  reasoning: {
    enabled: true,
    selected: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  thinking: { enabled: true, defaultBudget: 10_000 },
  planMode: { enabled: true },
  attachments: { enabled: true, kinds: ['image', 'text'] },
  slashCommands: { enabled: true },
  usageStats: { enabled: true, contextWindow: true },
  rewind: { enabled: true },
};

const baselineTokenStats: TokenStats = {
  inputTokens: 5400,
  outputTokens: 1200,
  cacheReadInputTokens: 320,
  cacheCreationInputTokens: 0,
  totalCostUsd: 0.041,
  totalDurationMs: 2200,
  totalDurationApiMs: 1800,
  turnCount: 6,
  webSearchRequests: 0,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  serviceTier: 'default',
};

const noop = () => undefined;

export default function MobileBaselinePage() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [repoPath, setRepoPath] = useState('/Users/example/repos/mobile-app');
  const [startupScript, setStartupScript] = useState('pnpm install && pnpm dev');
  const [scriptType, setScriptType] = useState<'command' | 'path'>('command');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [chatSettings, setChatSettings] = useState<ChatSettings>({
    selectedModel: 'sonnet',
    reasoningEffort: 'medium',
    thinkingEnabled: false,
    planModeEnabled: false,
  });

  const selectedPR = mobileBaselinePRs[selectedIndex] ?? null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-3 md:p-6">
        <PageHeader title="Mobile Baseline" description="Playwright mobile regression surface">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="working">Working</SelectItem>
              <SelectItem value="waiting">Waiting</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm">
            <List className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm">
            <GitBranch className="h-4 w-4 mr-2" />
            Resume branch
          </Button>
          <Button size="sm">
            <Plus className="h-4 w-4 mr-2" />
            New Workspace
          </Button>
        </PageHeader>

        <div className="rounded-lg border bg-card p-3 md:p-4">
          <ProjectRepoForm
            error=""
            repoPath={repoPath}
            setRepoPath={setRepoPath}
            isElectron={false}
            handleBrowse={async () => undefined}
            factoryConfigExists
            helperText="Path to a git repository on your local machine."
            scriptType={scriptType}
            setScriptType={setScriptType}
            startupScript={startupScript}
            setStartupScript={setStartupScript}
            idPrefix="mobile-baseline"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            isSubmitting={false}
            submitLabel="Add Project"
            submittingLabel="Adding..."
            footerActions={
              <Button variant="secondary" type="button">
                Cancel
              </Button>
            }
          />
        </div>

        <div className="rounded-lg border bg-card p-2">
          <div className="px-2 py-1.5 text-sm font-medium border-b">Reviews Demo</div>
          <div className="space-y-2 p-2">
            {mobileBaselinePRs.map((pr, index) => (
              <PRInboxItem
                key={`${pr.repository.nameWithOwner}#${pr.number}`}
                pr={pr}
                isSelected={selectedIndex === index}
                onSelect={() => {
                  setSelectedIndex(index);
                  setReviewOpen(true);
                }}
              />
            ))}
          </div>

          <Sheet open={reviewOpen} onOpenChange={setReviewOpen}>
            <SheetContent side="bottom" className="h-[88dvh] w-full max-w-none p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Review Details</SheetTitle>
                <SheetDescription>Mobile review request detail panel</SheetDescription>
              </SheetHeader>
              <PRDetailPanel
                pr={selectedPR}
                diff={`diff --git a/src/app.tsx b/src/app.tsx\nindex 111..222 100644\n--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -1,3 +1,4 @@\n import React from 'react';\n+import { useMemo } from 'react';\n export default function App() {\n   return <div>Hello</div>;\n }`}
                diffLoading={false}
                onFetchDiff={noop}
                onOpenGitHub={noop}
                onApprove={noop}
              />
            </SheetContent>
          </Sheet>
        </div>

        <div data-testid="mobile-chat-demo" className="rounded-lg border bg-card p-2">
          <div className="px-2 py-1.5 text-sm font-medium border-b">Chat Composer Demo</div>
          <div className="h-[60dvh] min-h-[420px] flex flex-col overflow-hidden">
            <div
              data-testid="mobile-chat-messages"
              className="flex-1 overflow-y-auto p-3 space-y-2 text-sm"
            >
              {Array.from({ length: 20 }, (_, i) => `msg-${i}`).map((id, index) => (
                <div key={id} className="rounded-md border bg-muted/40 px-3 py-2">
                  Sample message {index + 1}
                </div>
              ))}
            </div>
            <div
              data-testid="mobile-chat-composer"
              className="sticky bottom-0 z-20 border-t bg-background pb-safe"
            >
              <ChatInput
                onSend={noop}
                disabled={false}
                running={false}
                value={draft}
                onChange={setDraft}
                settings={chatSettings}
                capabilities={mobileBaselineCapabilities}
                onSettingsChange={(next) => {
                  setChatSettings((prev) => ({ ...prev, ...next }));
                }}
                tokenStats={baselineTokenStats}
                slashCommands={[
                  { name: '/plan', description: 'Draft a plan' },
                  { name: '/review', description: 'Review recent changes' },
                ]}
                slashCommandsLoaded
                workspaceId="mobile-baseline-workspace"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
