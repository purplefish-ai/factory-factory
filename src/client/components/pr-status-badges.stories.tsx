import type { Meta, StoryObj } from '@storybook/react';
import type { GitHubStatusCheck } from '@/shared/github-types';
import {
  CIChecksSection,
  CIStatusBadge,
  CIStatusDot,
  ReviewDecisionBadge,
} from './pr-status-badges';

// Mock data
const mockChecks: GitHubStatusCheck[] = [
  {
    __typename: 'CheckRun',
    name: 'Build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/example/repo/actions/runs/1',
  },
  {
    __typename: 'CheckRun',
    name: 'Test',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/example/repo/actions/runs/2',
  },
  {
    __typename: 'CheckRun',
    name: 'Lint',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
  },
];

const mockFailingChecks: GitHubStatusCheck[] = [
  {
    __typename: 'CheckRun',
    name: 'Build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
  },
  {
    __typename: 'CheckRun',
    name: 'Test',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/example/repo/actions/runs/2',
  },
];

const mockPendingChecks: GitHubStatusCheck[] = [
  {
    __typename: 'CheckRun',
    name: 'Build',
    status: 'IN_PROGRESS',
    conclusion: null,
  },
  {
    __typename: 'CheckRun',
    name: 'Test',
    status: 'PENDING',
    conclusion: null,
  },
];

// CIStatusDot Stories
const metaDot = {
  title: 'PR Review/CIStatusDot',
  component: CIStatusDot,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof CIStatusDot>;

export default metaDot;
type StoryDot = StoryObj<typeof metaDot>;

export const Pass: StoryDot = {
  args: {
    checks: mockChecks,
    size: 'sm',
  },
};

export const Fail: StoryDot = {
  args: {
    checks: mockFailingChecks,
    size: 'sm',
  },
};

export const Pending: StoryDot = {
  args: {
    checks: mockPendingChecks,
    size: 'sm',
  },
};

export const NoChecks: StoryDot = {
  args: {
    checks: null,
    size: 'sm',
  },
};

export const MediumSize: StoryDot = {
  args: {
    checks: mockChecks,
    size: 'md',
  },
};

export const AllStates: StoryDot = {
  args: {
    checks: mockChecks,
    size: 'sm',
  },
  render: () => (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <CIStatusDot checks={mockChecks} />
        <span className="text-xs">Pass</span>
      </div>
      <div className="flex items-center gap-2">
        <CIStatusDot checks={mockFailingChecks} />
        <span className="text-xs">Fail</span>
      </div>
      <div className="flex items-center gap-2">
        <CIStatusDot checks={mockPendingChecks} />
        <span className="text-xs">Pending</span>
      </div>
      <div className="flex items-center gap-2">
        <CIStatusDot checks={null} />
        <span className="text-xs">None</span>
      </div>
    </div>
  ),
};

// CIStatusBadge Stories
export const BadgePass: StoryObj<typeof CIStatusBadge> = {
  render: () => <CIStatusBadge checks={mockChecks} />,
};

export const BadgeFail: StoryObj<typeof CIStatusBadge> = {
  render: () => <CIStatusBadge checks={mockFailingChecks} />,
};

export const BadgePending: StoryObj<typeof CIStatusBadge> = {
  render: () => <CIStatusBadge checks={mockPendingChecks} />,
};

export const BadgeNoChecks: StoryObj<typeof CIStatusBadge> = {
  render: () => <CIStatusBadge checks={null} />,
};

export const AllBadgeStates: StoryObj<typeof CIStatusBadge> = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <CIStatusBadge checks={mockChecks} />
      <CIStatusBadge checks={mockFailingChecks} />
      <CIStatusBadge checks={mockPendingChecks} />
      <CIStatusBadge checks={null} />
    </div>
  ),
};

// ReviewDecisionBadge Stories
export const Approved: StoryObj<typeof ReviewDecisionBadge> = {
  render: () => <ReviewDecisionBadge decision="APPROVED" />,
};

export const ChangesRequested: StoryObj<typeof ReviewDecisionBadge> = {
  render: () => <ReviewDecisionBadge decision="CHANGES_REQUESTED" />,
};

export const ReviewRequired: StoryObj<typeof ReviewDecisionBadge> = {
  render: () => <ReviewDecisionBadge decision="REVIEW_REQUIRED" />,
};

export const PendingReview: StoryObj<typeof ReviewDecisionBadge> = {
  render: () => <ReviewDecisionBadge decision={null} />,
};

export const AllReviewStates: StoryObj<typeof ReviewDecisionBadge> = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <ReviewDecisionBadge decision="APPROVED" />
      <ReviewDecisionBadge decision="CHANGES_REQUESTED" />
      <ReviewDecisionBadge decision="REVIEW_REQUIRED" />
      <ReviewDecisionBadge decision={null} />
    </div>
  ),
};

// CIChecksSection Stories
export const ChecksSectionPass: StoryObj<typeof CIChecksSection> = {
  render: () => (
    <div className="w-[400px] border rounded">
      <CIChecksSection checks={mockChecks} defaultExpanded={true} />
    </div>
  ),
};

export const ChecksSectionFail: StoryObj<typeof CIChecksSection> = {
  render: () => (
    <div className="w-[400px] border rounded">
      <CIChecksSection checks={mockFailingChecks} defaultExpanded={true} />
    </div>
  ),
};

export const ChecksSectionPending: StoryObj<typeof CIChecksSection> = {
  render: () => (
    <div className="w-[400px] border rounded">
      <CIChecksSection checks={mockPendingChecks} defaultExpanded={true} />
    </div>
  ),
};

export const ChecksSectionCollapsed: StoryObj<typeof CIChecksSection> = {
  render: () => (
    <div className="w-[400px] border rounded">
      <CIChecksSection checks={mockChecks} defaultExpanded={false} />
    </div>
  ),
};

export const ChecksSectionMixed: StoryObj<typeof CIChecksSection> = {
  render: () => {
    const mixedChecks: GitHubStatusCheck[] = [
      {
        __typename: 'CheckRun',
        name: 'Build',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      },
      {
        __typename: 'CheckRun',
        name: 'Test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      },
      {
        __typename: 'CheckRun',
        name: 'Lint',
        status: 'IN_PROGRESS',
        conclusion: null,
      },
      {
        __typename: 'CheckRun',
        name: 'Deploy',
        status: 'COMPLETED',
        conclusion: 'SKIPPED',
      },
    ];
    return (
      <div className="w-[400px] border rounded">
        <CIChecksSection checks={mixedChecks} defaultExpanded={true} />
      </div>
    );
  },
};
