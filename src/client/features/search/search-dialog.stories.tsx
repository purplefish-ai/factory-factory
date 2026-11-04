import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { useEffect, useLayoutEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ThemeProvider } from '@/client/components/theme-provider';
import { Button } from '@/components/ui/button';
import type { SearchResult } from '@/shared/search';
import { SearchDialog, type SearchDialogProps } from './search-dialog';

const results: SearchResult[] = [
  {
    kind: 'workspace',
    id: 'ws1',
    title: 'Universal search',
    subtitle: 'Factory Factory · feature/universal-search · Issue #123 · PR #789',
    projectSlug: 'factory-factory',
    workspaceId: 'ws1',
    sessionId: null,
    archived: false,
  },
  {
    kind: 'session',
    id: 'chat1',
    title: 'Search interaction polish',
    subtitle: 'Factory Factory · Universal search',
    projectSlug: 'factory-factory',
    workspaceId: 'ws1',
    sessionId: 'chat1',
    archived: false,
  },
  {
    kind: 'project',
    id: 'project1',
    title: 'Factory Factory',
    subtitle: '~/Projects/factory-factory',
    projectSlug: 'factory-factory',
    workspaceId: null,
    sessionId: null,
    archived: false,
  },
  {
    kind: 'workspace',
    id: 'ws2',
    title: 'Search performance',
    subtitle: 'Factory Factory · fix/search-ranking',
    projectSlug: 'factory-factory',
    workspaceId: 'ws2',
    sessionId: null,
    archived: true,
  },
];

function InteractiveSearch(props: SearchDialogProps) {
  const [query, setQuery] = useState(props.query);
  const [includeArchived, setIncludeArchived] = useState(props.includeArchived);
  useEffect(() => setQuery(props.query), [props.query]);
  useEffect(() => setIncludeArchived(props.includeArchived), [props.includeArchived]);
  return (
    <SearchDialog
      {...props}
      query={query}
      onQueryChange={setQuery}
      includeArchived={includeArchived}
      onIncludeArchivedChange={setIncludeArchived}
      results={props.results.filter(
        (r) =>
          (includeArchived || !r.archived) &&
          `${r.title} ${r.subtitle} ${r.matchSnippet ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase())
      )}
    />
  );
}

const meta = {
  title: 'Features/Search',
  component: SearchDialog,
  render: InteractiveSearch,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    onOpenChange: () => undefined,
    query: '',
    onQueryChange: () => undefined,
    includeArchived: false,
    onIncludeArchivedChange: () => undefined,
    results,
    loading: false,
    error: false,
    onRetry: () => undefined,
    onSelect: () => undefined,
  },
} satisfies Meta<typeof SearchDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Recent: Story = {};

function BrowserChromeSearch({ theme, ...props }: SearchDialogProps & { theme: 'light' | 'dark' }) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (document.querySelector('meta[name="theme-color"]')) {
      return;
    }
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    return () => meta.remove();
  }, []);
  return (
    <NextThemesProvider attribute="class" forcedTheme={theme} enableSystem={false}>
      <ThemeProvider>
        <InteractiveSearch
          {...props}
          open={open}
          onOpenChange={setOpen}
          trigger={<Button>Search</Button>}
        />
      </ThemeProvider>
    </NextThemesProvider>
  );
}

export const BrowserChrome: Story = {
  render: (args, context) => (
    <BrowserChromeSearch {...args} theme={context.globals.theme === 'dark' ? 'dark' : 'light'} />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Opening search also dims the theme-color used for installed PWA corner backgrounds. Native window controls require an installed PWA to inspect visually.',
      },
    },
  },
  play: async ({ canvasElement, globals }) => {
    const doc = canvasElement.ownerDocument;
    const body = within(doc.body);
    const themeColor = () => doc.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    await waitFor(() =>
      expect(
        doc.documentElement.classList.contains(globals.theme === 'dark' ? 'dark' : 'light')
      ).toBe(true)
    );
    await waitFor(() => expect(themeColor()).toBeTruthy());
    const original = themeColor();
    await userEvent.click(body.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(themeColor()).not.toBe(original));
    await userEvent.click(body.getByRole('button', { name: 'Close search' }));
    await waitFor(() => expect(themeColor()).toBe(original));
  },
};

export const Results: Story = {
  args: { query: 'search' },
  play: async ({ canvasElement }) => {
    // Session results use the glossary term "Chat", matching the chat tabs they open.
    const option = await within(canvasElement.ownerDocument.body).findByRole('option', {
      name: /Search interaction polish/,
    });
    await expect(option).toHaveTextContent('Chat');
  },
};
export const Empty: Story = { args: { query: 'missing', results: [] } };
export const Loading: Story = { args: { query: 'search', loading: true } };
export const Unavailable: Story = {
  args: { error: true, results: [], onRetry: fn(), onSelect: fn() },
  play: async ({ canvasElement, args }) => {
    const retry = within(canvasElement.ownerDocument.body).getByRole('button', {
      name: 'Try again',
    });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onRetry).toHaveBeenCalledOnce();
    await expect(args.onSelect).not.toHaveBeenCalled();
  },
};
export const Archived: Story = { args: { includeArchived: true } };
export const MetadataMatch: Story = {
  args: {
    query: 'omnibox',
    results: [{ ...results[0]!, matchSnippet: 'Add Omnibox support to the workspace header' }],
  },
};
export const LongNames: Story = {
  args: {
    results: [
      {
        ...results[0]!,
        title:
          'A very long workspace name to verify the search dialog stays contained on a narrow screen',
        subtitle:
          'Another project with a lengthy name · martin/feature/a-long-branch-name-with-details · ENG-12345',
      },
    ],
  },
};

const githubIssues = {
  results: [
    {
      kind: 'github_issue' as const,
      id: 'p1:42',
      title: 'Improve search keyboard navigation',
      subtitle: 'Factory Factory · purplefish-ai/factory-factory · Issue #42',
      projectId: 'p1',
      projectSlug: 'factory-factory',
      workspaceId: null,
      sessionId: null,
      archived: false,
      githubIssue: {
        number: 42,
        title: 'Improve search keyboard navigation',
        body: 'Details',
        url: 'https://github.com/purplefish-ai/factory-factory/issues/42',
        state: 'OPEN' as const,
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'martin' },
      },
    },
  ],
  loading: false,
  error: false,
  onRetry: fn(),
};
export const GitHubIssues: Story = {
  args: { query: 'search', githubIssues, onSelect: fn() },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('option', { name: /Improve search keyboard navigation/ }));
    await expect(args.onSelect).toHaveBeenCalledWith(githubIssues.results[0]);
  },
};
export const GitHubLoading: Story = {
  args: { query: 'search', githubIssues: { ...githubIssues, results: [], loading: true } },
};
export const GitHubUnavailable: Story = {
  args: { query: 'search', githubIssues: { ...githubIssues, results: [], error: true } },
};

export const GitHubSearchAction: Story = {
  args: { query: 'search', onSearchGitHub: fn() },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement.ownerDocument.body).getByRole('option', {
        name: /Search GitHub issues for/,
      })
    );
    await expect(args.onSearchGitHub).toHaveBeenCalledOnce();
  },
};
