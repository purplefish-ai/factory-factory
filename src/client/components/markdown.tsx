import { memo, type ComponentPropsWithoutRef, type ReactElement } from 'react';
import {
  MarkdownRenderer as BaseMarkdownRenderer,
  type MarkdownRendererProps,
} from '@/components/ui/markdown';
import { GitHubPRLink } from './github-pr-link';

function renderExternalLink(link: ReactElement<ComponentPropsWithoutRef<'a'>>) {
  return <GitHubPRLink link={link} />;
}

/** Application Markdown adds GitHub previews without coupling the UI primitive to tRPC. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  return <BaseMarkdownRenderer {...props} renderExternalLink={renderExternalLink} />;
});
