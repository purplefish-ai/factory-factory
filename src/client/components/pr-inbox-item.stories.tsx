import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { PRWithFullDetails } from '@/shared/github-types';
import { PRInboxItem } from './pr-inbox-item';

const meta = {
  title: 'PR Review/PRInboxItem',
  component: PRInboxItem,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[400px] border rounded p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PRInboxItem>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockPR: PRWithFullDetails = {
  number: 123,
  title: 'Add new feature for user authentication',
  url: 'https://github.com/example/repo/pull/123',
  author: { login: 'johndoe' },
  repository: { name: 'repo', nameWithOwner: 'example/repo' },
  createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 mins ago
  updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 mins ago
  isDraft: false,
  state: 'OPEN',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
  reviews: [],
  comments: [
    { id: '1', author: { login: 'reviewer' }, body: 'LGTM', createdAt: '', updatedAt: '', url: '' },
  ],
  labels: [{ name: 'feature', color: '0e8a16' }],
  additions: 150,
  deletions: 25,
  changedFiles: 8,
  headRefName: 'feature/auth',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
};

const mockApprovedPR: PRWithFullDetails = {
  ...mockPR,
  number: 124,
  title: 'Fix critical bug in payment processing',
  reviewDecision: 'APPROVED',
  labels: [{ name: 'bug', color: 'd73a4a' }],
};

const mockDraftPR: PRWithFullDetails = {
  ...mockPR,
  number: 125,
  title: 'WIP: Refactor database layer',
  isDraft: true,
  reviewDecision: null,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Build', status: 'IN_PROGRESS', conclusion: null },
  ],
};

const mockFailingPR: PRWithFullDetails = {
  ...mockPR,
  number: 126,
  title: 'Update dependencies to latest versions',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  reviewDecision: 'CHANGES_REQUESTED',
};

const mockLongTitlePR: PRWithFullDetails = {
  ...mockPR,
  number: 127,
  title:
    'This is a very long PR title that should be truncated when displayed in the inbox item to prevent layout issues',
  additions: 1500,
  deletions: 800,
};

export const Default: Story = {
  args: {
    pr: mockPR,
    isSelected: false,
    onSelect: () => undefined,
  },
};

export const Selected: Story = {
  args: {
    pr: mockPR,
    isSelected: true,
    onSelect: () => undefined,
  },
};

export const Approved: Story = {
  args: {
    pr: mockApprovedPR,
    isSelected: false,
    onSelect: () => undefined,
  },
};

export const Draft: Story = {
  args: {
    pr: mockDraftPR,
    isSelected: false,
    onSelect: () => undefined,
  },
};

export const FailingCI: Story = {
  args: {
    pr: mockFailingPR,
    isSelected: false,
    onSelect: () => undefined,
  },
};

export const LongTitle: Story = {
  args: {
    pr: mockLongTitlePR,
    isSelected: false,
    onSelect: () => undefined,
  },
};

export const Interactive: Story = {
  args: {
    pr: mockPR,
    isSelected: false,
    onSelect: () => undefined,
  },
  render: function InteractiveStory() {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const prs = [mockPR, mockApprovedPR, mockDraftPR, mockFailingPR];

    return (
      <div className="w-[400px] border rounded p-2 space-y-1">
        {prs.map((pr, index) => (
          <PRInboxItem
            key={pr.number}
            pr={pr}
            isSelected={index === selectedIndex}
            onSelect={() => setSelectedIndex(index)}
          />
        ))}
      </div>
    );
  },
};
