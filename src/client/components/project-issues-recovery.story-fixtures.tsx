import { type ReactNode, useRef } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StoryTrpcProvider, type StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';

const response = {
  issues: [
    {
      number: 7,
      title: 'Retained issue',
      body: '',
      url: 'https://github.com/acme/repo/issues/7',
      createdAt: '2026-11-04T12:00:00Z',
      author: { login: 'octocat' },
    },
  ],
  error: null,
};

function RefreshControls({
  projectId,
  releaseRetry,
  failNext,
  holdNext,
}: {
  projectId: string;
  failNext: () => void;
  holdNext: () => void;
  releaseRetry: () => void;
}) {
  const utils = trpc.useUtils();
  return (
    <div className="flex gap-2 p-2">
      <button
        type="button"
        onClick={() => {
          failNext();
          void utils.github.listIssuesForProject.invalidate({ projectId });
        }}
      >
        Fail background refresh
      </button>
      <button type="button" onClick={holdNext}>
        Hold next retry
      </button>
      <button type="button" onClick={releaseRetry}>
        Complete retry
      </button>
    </div>
  );
}

/** One real tRPC success, one transport failure, then a deliberately pending retry. */
export function IssueRefreshRecoveryFixture({
  projectId,
  children,
  handlers = {},
}: {
  projectId: string;
  children: ReactNode;
  handlers?: StoryTrpcHandlers;
}) {
  const state = useRef<{ failNext: boolean; holdNext: boolean; release?: () => void }>({
    failNext: false,
    holdNext: false,
  });
  return (
    <StoryTrpcProvider
      handlers={{
        ...handlers,
        'github.listIssuesForProject': () => {
          if (state.current.failNext) {
            state.current.failNext = false;
            throw new Error('Network offline');
          }
          if (state.current.holdNext) {
            state.current.holdNext = false;
            return new Promise((resolve) => {
              state.current.release = () => resolve(response);
            });
          }
          return response;
        },
      }}
    >
      <RefreshControls
        projectId={projectId}
        failNext={() => {
          state.current.failNext = true;
        }}
        holdNext={() => {
          state.current.holdNext = true;
        }}
        releaseRetry={() => state.current.release?.()}
      />
      {children}
    </StoryTrpcProvider>
  );
}

export async function exerciseIssueRefreshRecovery(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText('Retained issue')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Fail background refresh' }));
  await expect(await canvas.findByText('Network offline')).toBeVisible();
  await expect(canvas.getByText('Retained issue')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Hold next retry' }));
  await userEvent.click(canvas.getByRole('button', { name: /^Retry$/ }));
  await expect(await canvas.findByRole('button', { name: 'Retrying…' })).toBeDisabled();
  await expect(canvas.getByText('Retained issue')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Complete retry' }));
  await waitFor(() => expect(canvas.queryByText('Network offline')).not.toBeInTheDocument());
  await expect(canvas.getByText('Retained issue')).toBeVisible();
  await expect(canvas.queryByText('No assigned issues')).not.toBeInTheDocument();
}
