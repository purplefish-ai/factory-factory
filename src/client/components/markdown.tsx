import { cloneElement, memo, type ComponentPropsWithoutRef, type ReactElement } from 'react';
import { usePortSharing } from '@/client/hooks/use-port-sharing';
import { toPortShareLink } from '@/client/lib/loopback-links';
import {
  MarkdownRenderer as BaseMarkdownRenderer,
  type MarkdownRendererProps,
} from '@/components/ui/markdown';
import { parseGitHubIssueLink } from '@/shared/github-issue-preview';
import { GitHubIssueLink } from './github-issue-link';
import { GitHubPRLink } from './github-pr-link';
import { MarkdownImage } from './markdown-image';
import { renderStreamdownContent } from './streamdown-markdown';

type MarkdownLink = ReactElement<ComponentPropsWithoutRef<'a'>>;

function renderImage(props: { src?: string; alt?: string; title?: string }) {
  return <MarkdownImage {...props} />;
}

/** Under `ff tailscale`, host loopback links open through a shared Tailscale port. */
function LoopbackAwareLink({ link }: { link: MarkdownLink }) {
  const portSharing = usePortSharing();
  const shared = portSharing === true && link.props.href ? toPortShareLink(link.props.href) : null;
  if (!shared) {
    return link;
  }
  return cloneElement(link, {
    href: shared.href,
    title: `Opens port ${shared.port} on the host through Tailscale`,
  });
}

function renderExternalLink(link: MarkdownLink) {
  const href = link.props.href;
  if (href && parseGitHubIssueLink(href)) {
    return <GitHubIssueLink link={link} />;
  }
  if (href && toPortShareLink(href)) {
    return <LoopbackAwareLink link={link} />;
  }
  return <GitHubPRLink link={link} />;
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
