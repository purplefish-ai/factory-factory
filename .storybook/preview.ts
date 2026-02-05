import { withThemeByClassName } from '@storybook/addon-themes';
import type { Preview } from '@storybook/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';

import '../src/client/globals.css';

const preview: Preview = {
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
    (Story) =>
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TooltipProvider, null, React.createElement(Story))
      ),
    withThemeByClassName({
      themes: {
        light: '',
        dark: 'dark',
      },
      defaultTheme: 'light',
    }),
  ],
  tags: ['autodocs'],
};

export default preview;
