import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import type { SearchResult } from '@/shared/search';
import { SearchDialog, type SearchDialogProps } from './search-dialog';

const results: SearchResult[] = [
  {
    kind: 'workspace',
    id: 'ws1',
    title: 'Universal search',
    subtitle: 'Factory Factory · feature/universal-search · #123',
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
export const Results: Story = { args: { query: 'search' } };
export const Empty: Story = { args: { query: 'missing', results: [] } };
export const Loading: Story = { args: { query: 'search', loading: true } };
export const Unavailable: Story = { args: { error: true, results: [] } };
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
