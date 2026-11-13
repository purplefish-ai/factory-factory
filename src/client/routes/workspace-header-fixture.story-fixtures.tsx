import type { Meta } from '@storybook/react';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';

/**
 * Meta shared by the `Navigation/AppHeader` story files. Each file sets its own
 * literal `title` because Storybook's indexer reads it statically.
 */
export const workspaceHeaderMeta = {
  component: WorkspaceHeaderFixture,
  parameters: {
    layout: 'fullscreen',
    docs: {
      // Native-geometry CSS and rem-based font previews need their own document
      // when the docs page shows several header stories at once.
      story: { inline: false, iframeHeight: 120 },
      description: {
        component:
          'The installed desktop PWA uses compact controls centered in the browser-reported title-bar area. A full-width border sits below the native title-bar area so window controls cannot cover its ends. The header background matches the native window-control corners in every theme. Larger fonts can grow the row without clipping. Empty space drags the window; interactive controls remain clickable. PWA stories simulate native geometry using the production CSS. Browser tabs and unsupported installations retain the standard header.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceHeaderFixture>;
