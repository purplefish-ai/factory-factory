import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { PRWithFullDetails } from '@/shared/github-types';
import { PRDetailPanel } from './pr-detail-panel';

const meta = {
  title: 'PR Review/PRDetailPanel',
  component: PRDetailPanel,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[600px] border rounded overflow-hidden">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PRDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockPR: PRWithFullDetails = {
  number: 123,
  title: 'Add new feature for user authentication',
  url: 'https://github.com/example/repo/pull/123',
  author: { login: 'johndoe' },
  repository: { name: 'repo', nameWithOwner: 'example/repo' },
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  isDraft: false,
  state: 'OPEN',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
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
  ],
  reviews: [
    {
      id: '1',
      author: { login: 'alice' },
      state: 'COMMENTED',
      submittedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      body: 'Looks good overall',
    },
  ],
  comments: [
    {
      id: '1',
      author: { login: 'alice' },
      body: 'Great work! Just a few minor suggestions:\n\n1. Consider adding more tests\n2. The variable naming could be improved\n\n```js\nconst user = getUser();\n```',
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      url: 'https://github.com/example/repo/pull/123#issuecomment-1',
    },
    {
      id: '2',
      author: { login: 'johndoe' },
      body: "Thanks for the feedback! I'll address those in the next commit.",
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      url: 'https://github.com/example/repo/pull/123#issuecomment-2',
    },
  ],
  labels: [
    { name: 'feature', color: '0e8a16' },
    { name: 'needs-review', color: 'fbca04' },
  ],
  additions: 150,
  deletions: 25,
  changedFiles: 8,
  headRefName: 'feature/auth',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
};

const mockApprovedPR: PRWithFullDetails = {
  ...mockPR,
  reviewDecision: 'APPROVED',
  reviews: [
    {
      id: '1',
      author: { login: 'alice' },
      state: 'APPROVED',
      submittedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    },
    {
      id: '2',
      author: { login: 'bob' },
      state: 'APPROVED',
      submittedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    },
  ],
};

const mockChangesRequestedPR: PRWithFullDetails = {
  ...mockPR,
  reviewDecision: 'CHANGES_REQUESTED',
  mergeStateStatus: 'BLOCKED',
  reviews: [
    {
      id: '1',
      author: { login: 'alice' },
      state: 'CHANGES_REQUESTED',
      submittedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      body: 'Please fix the security issue',
    },
  ],
};

const mockDiff = `diff --git a/src/auth/login.ts b/src/auth/login.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/auth/login.ts
@@ -0,0 +1,25 @@
+import { validateCredentials } from './validate';
+import { createSession } from './session';
+
+export interface LoginParams {
+  email: string;
+  password: string;
+}
+
+export async function login(params: LoginParams) {
+  const { email, password } = params;
+
+  // Validate credentials
+  const user = await validateCredentials(email, password);
+  if (!user) {
+    throw new Error('Invalid credentials');
+  }
+
+  // Create session
+  const session = await createSession(user.id);
+
+  return {
+    user,
+    session,
+  };
+}
diff --git a/src/auth/logout.ts b/src/auth/logout.ts
index abcdef0..9876543
--- a/src/auth/logout.ts
+++ b/src/auth/logout.ts
@@ -1,5 +1,12 @@
 import { destroySession } from './session';

-export async function logout(sessionId: string) {
+export interface LogoutOptions {
+  sessionId: string;
+  clearCookies?: boolean;
+}
+
+export async function logout(options: LogoutOptions) {
+  const { sessionId, clearCookies = true } = options;
   await destroySession(sessionId);
+  return { success: true, clearedCookies: clearCookies };
 }`;

export const Default: Story = {
  args: {
    pr: mockPR,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
};

export const NoPRSelected: Story = {
  args: {
    pr: null,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
};

export const WithApprovedStatus: Story = {
  args: {
    pr: mockApprovedPR,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
};

export const WithChangesRequested: Story = {
  args: {
    pr: mockChangesRequestedPR,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
};

export const Approving: Story = {
  args: {
    pr: mockPR,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: true,
  },
};

export const WithDiff: Story = {
  args: {
    pr: mockPR,
    diff: mockDiff,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
  render: function WithDiffStory() {
    const [diff] = useState<string | null>(mockDiff);

    return (
      <PRDetailPanel
        pr={mockPR}
        diff={diff}
        diffLoading={false}
        onFetchDiff={() => undefined}
        onOpenGitHub={() => window.open(mockPR.url, '_blank')}
        onApprove={() => alert('Approve clicked')}
        approving={false}
      />
    );
  },
};

export const DiffLoading: Story = {
  args: {
    pr: mockPR,
    diff: null,
    diffLoading: true,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
};

export const Interactive: Story = {
  args: {
    pr: mockPR,
    diff: null,
    diffLoading: false,
    onFetchDiff: () => undefined,
    onOpenGitHub: () => undefined,
    onApprove: () => undefined,
    approving: false,
  },
  render: function InteractiveStory() {
    const [diff, setDiff] = useState<string | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [approving, setApproving] = useState(false);
    const [pr, setPR] = useState(mockPR);

    const handleFetchDiff = () => {
      setDiffLoading(true);
      setTimeout(() => {
        setDiff(mockDiff);
        setDiffLoading(false);
      }, 1000);
    };

    const handleApprove = () => {
      setApproving(true);
      setTimeout(() => {
        setApproving(false);
        setPR((prev) => ({ ...prev, reviewDecision: 'APPROVED' as const }));
      }, 1500);
    };

    return (
      <PRDetailPanel
        pr={pr}
        diff={diff}
        diffLoading={diffLoading}
        onFetchDiff={handleFetchDiff}
        onOpenGitHub={() => window.open(mockPR.url, '_blank')}
        onApprove={handleApprove}
        approving={approving}
      />
    );
  },
};
