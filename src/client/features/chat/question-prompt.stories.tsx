import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { createUserQuestion } from '@/lib/claude-fixtures';
import { QuestionPrompt } from './question-prompt';

const meta = {
  title: 'Chat/QuestionPrompt',
  component: QuestionPrompt,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Use the option list to answer quickly, or select the inline Other option to type a custom response.',
      },
    },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl border rounded-lg overflow-hidden">
        <div className="p-4 bg-background min-h-[100px]">
          <p className="text-sm text-muted-foreground">Chat messages would appear above...</p>
        </div>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    question: {
      control: 'object',
      description: 'The user question request to display, or null to hide the prompt',
    },
    onAnswer: {
      action: 'onAnswer',
      description: 'Callback when user submits their answers',
    },
  },
  args: {
    onAnswer: fn(),
  },
} satisfies Meta<typeof QuestionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleQuestion: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'What type of component would you like to create?',
        options: [
          {
            label: 'Functional Component',
            description: 'Modern React function component with hooks',
          },
          {
            label: 'Class Component',
            description: 'Traditional React class-based component',
          },
        ],
      },
    ]),
  },
};

export const SingleQuestionMultiSelect: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'Which features would you like to include?',
        multiSelect: true,
        options: [
          {
            label: 'TypeScript',
            description: 'Add TypeScript type definitions',
          },
          {
            label: 'Testing',
            description: 'Include unit test file',
          },
          {
            label: 'Storybook',
            description: 'Add Storybook story file',
          },
          {
            label: 'CSS Modules',
            description: 'Use CSS modules for styling',
          },
        ],
      },
    ]),
  },
};

export const MultipleQuestions: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'What type of component would you like to create?',
        options: [
          {
            label: 'Functional Component',
            description: 'Modern React function component with hooks',
          },
          {
            label: 'Class Component',
            description: 'Traditional React class-based component',
          },
        ],
      },
      {
        question: 'Where should the component be placed?',
        options: [
          {
            label: 'src/components',
            description: 'Main components directory',
          },
          {
            label: 'src/components/ui',
            description: 'UI primitives directory',
          },
          {
            label: 'src/components/shared',
            description: 'Shared components directory',
          },
        ],
      },
    ]),
  },
};

export const QuestionsWithHeaders: Story = {
  args: {
    question: createUserQuestion([
      {
        header: 'Component Configuration',
        question: 'Select the component type:',
        options: [
          {
            label: 'Server Component',
            description: 'React Server Component (RSC)',
          },
          {
            label: 'Client Component',
            description: "Client-side component with 'use client' directive",
          },
        ],
      },
      {
        header: 'Styling Options',
        question: 'Choose a styling approach:',
        options: [
          {
            label: 'Tailwind CSS',
            description: 'Utility-first CSS framework',
          },
          {
            label: 'CSS Modules',
            description: 'Scoped CSS with module imports',
          },
          {
            label: 'Styled Components',
            description: 'CSS-in-JS with styled-components',
          },
        ],
      },
    ]),
  },
};

export const ManyOptions: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'How should the API endpoint be structured?',
        options: [
          {
            label: 'tRPC',
            description: 'End-to-end typesafe procedures for TypeScript clients',
          },
          {
            label: 'GraphQL',
            description: 'Single endpoint with flexible queries',
          },
          {
            label: 'JSON-RPC',
            description: 'Procedure-style messaging over HTTP',
          },
          {
            label: 'Server Actions',
            description: 'Next.js 14+ server actions for form submissions',
          },
        ],
      },
    ]),
  },
};

export const NoQuestion: Story = {
  args: {
    question: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When question is null, the prompt is hidden and nothing is rendered.',
      },
    },
  },
};

export const OptionalNote: Story = {
  args: {
    question: createUserQuestion([
      { question: 'Additional answer or note', options: [], optional: true },
    ]),
  },
};

export const StrictChoice: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'Choose the configured region',
        options: [
          { label: 'US', description: 'United States' },
          { label: 'EU', description: 'Europe' },
        ],
        allowOther: false,
      },
    ]),
  },
};

export const NumericInput: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'How many workers should run?',
        options: [],
        validation: { type: 'integer', minimum: 1, maximum: 5 },
      },
    ]),
  },
};

export const OptionalProgress: Story = {
  args: {
    question: createUserQuestion([
      { question: 'Additional note', options: [], optional: true },
      {
        question: 'Choose a value',
        options: [
          {
            label: 'Empty value',
            value: '__blank_choice__',
            description: 'Example transport value: __blank_choice__',
          },
          { label: 'Default', description: 'Use the default setting' },
        ],
        allowOther: false,
      },
    ]),
  },
};

export const ConstrainedForm: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Required selections disable Submit while empty. Count validation appears after selecting an option.',
      },
    },
  },
  args: {
    question: createUserQuestion([
      {
        question: 'Contact email',
        options: [],
        validation: { type: 'string', format: 'email', maxLength: 80 },
      },
      {
        question: 'Choose two environments',
        options: ['Development', 'Staging', 'Production'].map((label) => ({
          label,
          description: '',
        })),
        multiSelect: true,
        allowOther: false,
        validation: { type: 'array', minItems: 2, maxItems: 2 },
      },
    ]),
  },
};

export const LiteralOtherValue: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'Choose a literal value or type a response',
        options: [
          {
            label: 'Literal __other__ value',
            value: '__other__',
            description:
              'Submits the provider value without selecting the free-form Other response.',
          },
        ],
      },
    ]),
  },
};
