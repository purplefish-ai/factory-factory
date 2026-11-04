import type { Meta, StoryObj } from '@storybook/react';
import { type ReactNode, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ProjectSelectorDropdown } from './project-selector';

const projectChange = fn();
const currentProject = fn();
const retryProjects = fn();

function ProjectPath({ path, children }: { path?: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (path && `${pathname}${search}` !== path) {
      void navigate(path);
    }
  }, [path, pathname, search, navigate]);
  return children;
}

const meta = {
  title: 'Navigation/ProjectSelector',
  component: ProjectSelectorDropdown,
  decorators: [
    (Story, context) => (
      <ProjectPath path={context.parameters.projectPath}>
        <Story />
      </ProjectPath>
    ),
  ],
  args: {
    selectedProjectSlug: 'alpha',
    projects: [
      { id: 'a', slug: 'alpha', name: 'Alpha' },
      { id: 'b', slug: 'beta', name: 'Beta' },
    ],
    onProjectChange: projectChange,
    onCurrentProjectSelect: currentProject,
  },
  beforeEach: () => {
    projectChange.mockClear();
    currentProject.mockClear();
    retryProjects.mockClear();
  },
} satisfies Meta<typeof ProjectSelectorDropdown>;
export default meta;
type Story = StoryObj<typeof meta>;
async function openMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Open project menu' }));
  return within(document.body);
}
export const ProjectActions: Story = {
  play: async ({ canvasElement, args }) => {
    let screen = await openMenu(canvasElement);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    await expect(args.onCurrentProjectSelect).toHaveBeenCalledOnce();
    screen = await openMenu(canvasElement);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
    await expect(args.onProjectChange).toHaveBeenLastCalledWith('beta');
    screen = await openMenu(canvasElement);
    await userEvent.click(screen.getByRole('menuitem', { name: /Create project/ }));
    await expect(args.onProjectChange).toHaveBeenLastCalledWith('__create__');
    screen = await openMenu(canvasElement);
    await userEvent.click(screen.getByRole('menuitem', { name: /Manage projects/ }));
    await expect(args.onProjectChange).toHaveBeenLastCalledWith('__manage__');
  },
};
export const RetryProjects: Story = {
  args: { projects: undefined, selectedProjectSlug: '', onRetryProjects: retryProjects },
  play: async ({ canvasElement, args }) => {
    const screen = await openMenu(canvasElement);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retry projects' }));
    await expect(args.onRetryProjects).toHaveBeenCalledOnce();
    await expect(args.onProjectChange).not.toHaveBeenCalled();
  },
};
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement, args }) => {
    within(canvasElement).getByRole('button', { name: 'Open project menu' }).focus();
    await userEvent.keyboard('{ArrowDown}b{Enter}');
    await expect(args.onProjectChange).toHaveBeenCalledWith('beta');
  },
};
export const ModifiedClick: Story = {
  play: async ({ canvasElement, args, parameters }) => {
    const screen = await openMenu(canvasElement);
    const beta = screen.getByRole('menuitem', { name: 'Beta' });
    await expect(beta).toHaveAttribute(
      'href',
      parameters.projectPath ? '/projects/beta/agents?kind=event' : '/projects/beta/workspaces'
    );
    let browserDefaultAvailable = false;
    // Observe React's handling, then stop synthetic navigation from leaving the
    // test frame. A real browser follows the href in a new tab.
    document.addEventListener(
      'click',
      (event) => {
        browserDefaultAvailable = !event.defaultPrevented;
        event.preventDefault();
      },
      { once: true }
    );
    beta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await expect(browserDefaultAvailable).toBe(true);
    await expect(args.onProjectChange).not.toHaveBeenCalled();
  },
};
export const PhoneLongProjectName: Story = {
  args: { projects: [{ id: 'a', slug: 'alpha', name: 'Factory Factory platform infrastructure' }] },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const screen = await openMenu(canvasElement);
    await expect(
      screen.getByRole('menuitem', { name: 'Factory Factory platform infrastructure' })
    ).toBeVisible();
  },
};

export const EventAgentModifiedClick: Story = {
  ...ModifiedClick,
  parameters: { projectPath: '/projects/alpha/agents/event-1?kind=event' },
};
