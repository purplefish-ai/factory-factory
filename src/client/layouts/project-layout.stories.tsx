import type { Meta, StoryObj } from '@storybook/react';
import { onlineManager } from '@tanstack/react-query';
import { TRPCError } from '@trpc/server';
import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { expect, userEvent, within } from 'storybook/test';
import { ProjectLayout } from './project-layout';

function ProjectRecovery() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname === '/') {
      void navigate('/projects/missing');
    }
  }, [navigate, pathname]);
  return (
    <Routes>
      <Route path="/projects/:slug" element={<ProjectLayout />} />
      <Route path="/projects" element={<p>Choose a project</p>} />
    </Routes>
  );
}
const meta = {
  title: 'Projects/ProjectRecovery',
  component: ProjectRecovery,
} satisfies Meta<typeof ProjectRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MissingProject: Story = {
  parameters: {
    trpc: {
      handlers: {
        'project.getBySlug': () => {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Project no longer exists' });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Project not found')).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: 'Go to projects' }));
    await expect(await canvas.findByText('Choose a project')).toBeVisible();
  },
};
export const ConnectionFailure: Story = {
  parameters: {
    trpc: {
      handlers: {
        'project.getBySlug': () => {
          throw new Error('Connection refused');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent("Couldn't load project");
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(canvas.queryByText('Project not found')).not.toBeInTheDocument();
  },
};

export const PausedProject: Story = {
  beforeEach: () => {
    onlineManager.setOnline(false);
    return () => onlineManager.setOnline(true);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Loading project…')).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Go to projects' })).not.toBeInTheDocument();
    await expect(canvas.queryByText('Project not found')).not.toBeInTheDocument();
  },
};
export const IdleProject: Story = {
  render: () => <ProjectLayout />,
  play: PausedProject.play,
};
