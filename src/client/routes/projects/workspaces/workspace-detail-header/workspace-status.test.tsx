import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspaceCiStatus } from './workspace-status';

vi.mock('@/client/components/ci-status-chip', () => ({
  CiStatusChip: ({ prState }: { prState: string }) => <span data-ci-state={prState} />,
}));
vi.mock('@/client/components/pr-state-badge', () => ({
  PrStateBadge: ({ prState }: { prState: string }) => <span data-badge-state={prState} />,
}));

it.each(['collection', 'scalar'] as const)(
  'keeps a %s Draft badge separate from the collection CI state',
  (source) => {
    const draft = {
      id: 'draft',
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      title: null,
      headRefName: null,
      baseRefName: null,
      state: 'DRAFT' as const,
      reviewState: null,
      ciStatus: 'PENDING' as const,
      hasMergeConflict: false,
      syncedAt: null,
    };
    const workspace = unsafeCoerce<WorkspaceHeaderWorkspace>({
      ...createOptimisticWorkspaceSummary({
        id: 'w',
        projectId: 'p',
        name: 'W',
        ratchetEnabled: true,
      }),
      prs: [draft],
      selectedPrId: draft.id,
      selectedPr: draft,
      prState: 'OPEN',
      prSummary: deriveWorkspacePRSummary([draft], true),
      sidebarStatus: { activityState: 'IDLE', ciState: 'RUNNING' },
      ...(source === 'scalar'
        ? { prs: undefined, selectedPr: undefined, prState: 'DRAFT', prUrl: draft.url }
        : {}),
    });
    const html = renderToStaticMarkup(<WorkspaceCiStatus workspace={workspace} />);
    expect(html).toContain('data-ci-state="OPEN"');
    expect(html).toContain('data-badge-state="DRAFT"');
  }
);
