import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ProjectSelectorDropdown } from './project-selector';
import { ProjectPath } from './project-selector.stories';

function ProjectStoryOrder() {
  const [isDefault, setIsDefault] = useState(false);
  const { pathname, search } = useLocation();
  const navigationType = useNavigationType();
  return (
    <ProjectPath path={isDefault ? undefined : '/projects/alpha/agents/event-1?kind=event'}>
      <ProjectSelectorDropdown
        selectedProjectSlug="alpha"
        projects={[{ id: 'b', slug: 'beta', name: 'Beta' }]}
        onProjectChange={fn()}
      />
      <button type="button" onClick={() => setIsDefault(true)}>
        Render default story
      </button>
      <output aria-label="Story route">
        {pathname}
        {search}
      </output>
      <output aria-label="Story navigation type">{navigationType}</output>
    </ProjectPath>
  );
}
const meta = {
  title: 'Navigation/ProjectSelectorRouting',
  component: ProjectStoryOrder,
} satisfies Meta<typeof ProjectStoryOrder>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EventThenDefault: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByLabelText('Story route')).toHaveTextContent(
        '/projects/alpha/agents/event-1?kind=event'
      )
    );
    await expect(canvas.getByLabelText('Story navigation type')).toHaveTextContent('REPLACE');
    await userEvent.click(canvas.getByRole('button', { name: /Open project menu/ }));
    await expect(within(document.body).getByRole('menuitem', { name: 'Beta' })).toHaveAttribute(
      'href',
      '/projects/beta/agents?kind=event'
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Render default story' }));
    await waitFor(() => expect(canvas.getByLabelText('Story route')).toHaveTextContent(/^\/$/));
    await expect(canvas.getByLabelText('Story navigation type')).toHaveTextContent('REPLACE');
    await userEvent.click(canvas.getByRole('button', { name: /Open project menu/ }));
    await expect(within(document.body).getByRole('menuitem', { name: 'Beta' })).toHaveAttribute(
      'href',
      '/projects/beta/workspaces'
    );
  },
};
