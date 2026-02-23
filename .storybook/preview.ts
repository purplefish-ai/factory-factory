import type { Preview } from '@storybook/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { TRPCProvider } from '@/client/lib/providers';
import { TooltipProvider } from '@/components/ui/tooltip';

import '../src/client/globals.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Global theme for all stories',
      defaultValue: 'light',
      toolbar: {
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: 'centered',
  },
  decorators: [
    (Story, context) =>
      React.createElement(
        'div',
        {
          className:
            context.globals.theme === 'dark'
              ? 'dark bg-background text-foreground'
              : 'bg-background text-foreground',
        },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            TRPCProvider,
            null,
            React.createElement(TooltipProvider, null, React.createElement(Story))
          )
        )
      ),
  ],
  tags: ['autodocs'],
};

export default preview;
