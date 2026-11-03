import { memo, type ComponentPropsWithoutRef, type ReactElement } from 'react';
import {
  MarkdownRenderer as BaseMarkdownRenderer,
  type MarkdownRendererProps,
} from '@/components/ui/markdown';
import { parseGitHubIssueLink } from '@/shared/github-issue-preview';
import { GitHubIssueLink } from './github-issue-link';
import { GitHubPRLink } from './github-pr-link';
import { MarkdownImage } from './markdown-image';
import { renderStreamdownContent } from './streamdown-markdown';

function renderImage(props: { src?: string; alt?: string; title?: string }) {
  return <MarkdownImage {...props} />;
}

function renderExternalLink(link: ReactElement<ComponentPropsWithoutRef<'a'>>) {
  return link.props.href && parseGitHubIssueLink(link.props.href) ? (
    <GitHubIssueLink link={link} />
  ) : (
    <GitHubPRLink link={link} />
  );
}

/** Application Markdown uses Streamdown with our links, images and typography. */
export const MarkdownRenderer = memo(function MarkdownRenderer(
  props: Omit<MarkdownRendererProps, 'renderExternalLink' | 'renderImage'>
) {
  return (
    <BaseMarkdownRenderer
      renderContent={renderStreamdownContent}
      {...props}
      renderExternalLink={renderExternalLink}
      renderImage={renderImage}
    />
  );
});
