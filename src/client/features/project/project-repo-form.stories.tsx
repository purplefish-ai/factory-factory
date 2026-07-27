import type { Meta, StoryObj } from '@storybook/react';
import type { ComponentProps, FormEvent } from 'react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { ProjectRepoForm } from './project-repo-form';

type StoryArgs = ComponentProps<typeof ProjectRepoForm>;

function InteractiveForm(args: StoryArgs) {
  const [repoPath, setRepoPath] = useState(args.repoPath);
  const [scriptType, setScriptType] = useState(args.scriptType);
  const [startupScript, setStartupScript] = useState(args.startupScript);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    args.onSubmit(event);
  };

  return (
    <div className="mx-auto w-full max-w-2xl rounded-md border bg-card p-6">
      <ProjectRepoForm
        {...args}
        repoPath={repoPath}
        setRepoPath={setRepoPath}
        scriptType={scriptType}
        setScriptType={setScriptType}
        startupScript={startupScript}
        setStartupScript={setStartupScript}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

const meta = {
  title: 'Pages/Projects/ProjectRepoForm',
  component: ProjectRepoForm,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  render: (args) => <InteractiveForm {...args} />,
  args: {
    error: '',
    repoPath: '/Users/martin/code/factory-factory',
    setRepoPath: fn(),
    isElectron: true,
    handleBrowse: async () => undefined,
    factoryConfigExists: true,
    helperText: 'Path to a git repository on your local machine.',
    scriptType: 'command',
    setScriptType: fn(),
    startupScript: 'pnpm dev',
    setStartupScript: fn(),
    idPrefix: 'storybook',
    onSubmit: fn(),
    isSubmitting: false,
    submitLabel: 'Add Project',
    submittingLabel: 'Adding...',
    footerActions: undefined,
    submitFullWidth: false,
  },
} satisfies Meta<typeof ProjectRepoForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {};

export const Onboarding: Story = {
  args: {
    submitFullWidth: true,
  },
};

export const WithValidationError: Story = {
  args: {
    error: 'Repository path is required',
    repoPath: '',
    factoryConfigExists: false,
  },
};

export const WithFooterActions: Story = {
  args: {
    footerActions: <Button variant="secondary">Cancel</Button>,
  },
};
