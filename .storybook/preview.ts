import type { Preview } from '@storybook/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { COLOR_SCHEME_ATTRIBUTE } from '@/client/lib/appearance';
import { TRPCProvider } from '@/client/lib/providers';
import { TooltipProvider } from '@/components/ui/tooltip';
import { COLOR_SCHEME_OPTIONS, DEFAULT_COLOR_SCHEME } from '@/shared/appearance';
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
    colorScheme: {
      name: 'Color scheme',
      description: 'Appearance color scheme preset (Settings → Appearance)',
      defaultValue: 'factory',
      toolbar: {
        icon: 'paintbrush',
        items: COLOR_SCHEME_OPTIONS.map((option) => ({ value: option.id, title: option.label })),
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
    (Story, context) => {
      // Presets are keyed off <html>, matching how the app applies them.
      document.documentElement.setAttribute(
        COLOR_SCHEME_ATTRIBUTE,
        typeof context.globals.colorScheme === 'string'
          ? context.globals.colorScheme
          : DEFAULT_COLOR_SCHEME
      );
      return React.createElement(
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
      );
    },
  ],
  tags: ['autodocs'],
};

export default preview;
