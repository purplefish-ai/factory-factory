import type { Preview } from '@storybook/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';
import { COLOR_SCHEME_ATTRIBUTE } from '@/client/lib/appearance';
import { StoryTrpcProvider, storyTrpcHandlersFrom } from '@/client/lib/storybook-trpc';
import { Toaster } from '@/components/ui/sonner';
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
    // Report accessibility violations in the Storybook panel and in
    // `pnpm test:storybook` without failing either yet (#2940).
    a11y: { test: 'todo' },
    viewport: {
      options: {
        ...MINIMAL_VIEWPORTS,
        // A modern phone width; layout-heavy stories should cover it.
        phone: {
          name: 'Phone (390px)',
          styles: { width: '390px', height: '844px' },
          type: 'mobile',
        },
      },
    },
    options: {
      // Group order follows docs/storybook.md. Storybook reads this statically,
      // so keep it an inline literal. Titles sort alphabetically within each
      // group; stories keep their export order.
      storySort: {
        method: 'alphabetical',
        order: [
          'Foundations',
          'UI',
          'Shared',
          'Navigation',
          'Board',
          'Workspace',
          'Chat',
          'Agents',
          'Reviews',
          'Projects',
          'Settings',
          '*',
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const { theme } = context.globals;
      // Presets are keyed off <html> (and its .dark class), matching how the
      // app applies them.
      document.documentElement.classList.toggle('dark', theme === 'dark');
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
            theme === 'dark'
              ? 'dark bg-background text-foreground'
              : 'bg-background text-foreground',
        },
        React.createElement(
          MemoryRouter,
          null,
          // Stories never reach a backend: tRPC requests are answered by
          // `parameters.trpc.handlers` and otherwise stay pending. Keyed by
          // story so each story starts with an empty query cache.
          React.createElement(
            StoryTrpcProvider,
            { key: context.id, handlers: storyTrpcHandlersFrom(context.parameters) },
            React.createElement(TooltipProvider, null, React.createElement(Story)),
            // The app's toaster, following the toolbar theme.
            React.createElement(Toaster, { theme: theme === 'dark' ? 'dark' : 'light' })
          )
        )
      );
    },
  ],
  tags: ['autodocs'],
};

export default preview;
