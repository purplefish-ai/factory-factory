import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider, useAppHeader } from '@/client/components/app-header-context';
import { MainViewTabBar } from '@/client/features/workspace/main-view-tab-bar';
import { WorkspacePanelProvider } from '@/client/features/workspace/workspace-panel-context';
import { contrastRatio, type Rgb } from '@/client/lib/color-contrast';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { WorkspaceHeaderPwaPreview } from './workspace-header-pwa-preview';

function ShellContent() {
  useAppHeader({ title: 'Factory Factory / Improve workspace surfaces' });
  const { open, setOpen } = useSidebar();
  return (
    <>
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        {open && (
          <aside
            aria-label="Navigation"
            className="w-48 shrink-0 border-r bg-sidebar p-4 text-sidebar-foreground"
          >
            <p className="font-semibold">Factory Factory</p>
            <p className="mt-4 rounded bg-sidebar-accent p-2 text-sm text-sidebar-accent-foreground">
              Workspaces
            </p>
            <p className="mt-2 text-sm">Reviews</p>
          </aside>
        )}
        <main className="min-w-0 flex-1 bg-background">
          <WorkspacePanelProvider workspaceId="shell-surfaces">
            <MainViewTabBar
              workspaceId="shell-surfaces"
              sessions={[{ id: 'chat', name: 'Chat 1', status: 'IDLE', provider: 'CLAUDE' }]}
              currentSessionId="chat"
              className="border-b"
            />
          </WorkspacePanelProvider>
          <div className="p-6 text-foreground">
            <p className="font-medium">What should the agent work on?</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Content stays distinct from the surrounding navigation.
            </p>
            <button type="button" className="mt-6 text-sm underline" onClick={() => setOpen(!open)}>
              Toggle preview navigation
            </button>
          </div>
        </main>
      </div>
    </>
  );
}

function ShellSurfacesFixture() {
  return (
    <SidebarProvider className="h-dvh min-h-0 flex-col bg-background">
      <AppHeaderProvider>
        <ShellContent />
      </AppHeaderProvider>
    </SidebarProvider>
  );
}

const meta = {
  title: 'Navigation/ShellSurfaces',
  component: ShellSurfacesFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ShellSurfacesFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function renderedRgb(color: string, background = 'white'): Rgb {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Expected canvas color conversion');
  }
  context.fillStyle = background;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return [red / 255, green / 255, blue / 255];
}

async function checkSurfaces(canvasElement: HTMLElement, native = false) {
  const header = canvasElement.querySelector('header');
  const tabs = canvasElement.querySelector('main > .border-b');
  if (!(header && tabs)) {
    throw new Error('Expected header and session tabs');
  }
  const probe = document.createElement('span');
  probe.className = 'bg-sidebar';
  canvasElement.append(probe);
  try {
    const sidebarColor = getComputedStyle(probe).backgroundColor;
    probe.className = 'bg-sidebar-accent text-muted-foreground';
    await expect(
      contrastRatio(
        renderedRgb(getComputedStyle(probe).color),
        renderedRgb(getComputedStyle(probe).backgroundColor)
      )
    ).toBeGreaterThanOrEqual(4.5);
    await expect(
      contrastRatio(renderedRgb(getComputedStyle(probe).backgroundColor), renderedRgb(sidebarColor))
    ).toBeGreaterThanOrEqual(1.08);
    const surface = native ? header.querySelector('.app-header-controls') : header;
    if (!surface) {
      throw new Error('Expected header controls');
    }
    const headerColor = getComputedStyle(surface, native ? '::before' : null).backgroundColor;
    await expect(headerColor).toBe(sidebarColor);
    await expect(getComputedStyle(tabs).backgroundColor).toBe(sidebarColor);
    const border = native ? getComputedStyle(header, '::after') : getComputedStyle(header);
    await expect(native ? border.height : border.borderBottomWidth).toBe('1px');
    const borderColor = native ? border.backgroundColor : border.borderBottomColor;
    await expect(borderColor).not.toBe(headerColor);
    await expect(
      contrastRatio(renderedRgb(getComputedStyle(header).color), renderedRgb(sidebarColor))
    ).toBeGreaterThanOrEqual(4.5);
    const root = canvasElement.ownerDocument.documentElement;
    if (root.classList.contains('dark') && root.getAttribute('data-color-scheme') === 'factory') {
      await expect(
        contrastRatio(renderedRgb(borderColor, sidebarColor), renderedRgb(sidebarColor))
      ).toBeGreaterThanOrEqual(1.5);
    }
  } finally {
    probe.remove();
  }
}

export const Light: Story = {
  play: async ({ canvasElement }) => {
    await checkSurfaces(canvasElement);
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Toggle preview navigation' })
    );
    await checkSurfaces(canvasElement);
  },
};
export const Dark: Story = { ...Light, globals: { theme: 'dark' } };
export const GithubLight: Story = { ...Light, globals: { colorScheme: 'github' } };
export const OneLight: Story = { ...Light, globals: { colorScheme: 'one' } };
export const OneDark: Story = { ...Light, globals: { theme: 'dark', colorScheme: 'one' } };
export const SolarizedLight: Story = { ...Light, globals: { colorScheme: 'solarized' } };
export const SolarizedDark: Story = {
  ...Light,
  globals: { theme: 'dark', colorScheme: 'solarized' },
};
export const HighContrastLight: Story = { ...Light, globals: { colorScheme: 'high-contrast' } };
export const GithubDark: Story = { ...Light, globals: { theme: 'dark', colorScheme: 'github' } };
export const HighContrast: Story = {
  ...Light,
  globals: { theme: 'dark', colorScheme: 'high-contrast' },
};
export const Phone: Story = {
  ...Light,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const InstalledLight: Story = {
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="left">
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
  play: async ({ canvasElement }) => {
    await checkSurfaces(canvasElement, true);
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Toggle preview navigation' })
    );
    await checkSurfaces(canvasElement, true);
  },
};
export const InstalledDark: Story = { ...InstalledLight, globals: { theme: 'dark' } };
