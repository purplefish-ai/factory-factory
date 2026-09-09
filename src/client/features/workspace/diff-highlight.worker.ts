import { tokenizeDiffLines } from '@/lib/diff/syntax-highlight';
import { diffHighlightRequestSchema } from './diff-highlight-protocol';

self.onmessage = (event: MessageEvent<unknown>) => {
  const request = diffHighlightRequestSchema.safeParse(event.data);
  if (!request.success) {
    self.postMessage(null);
    return;
  }
  const { lines, language, theme } = request.data;
  self.postMessage(tokenizeDiffLines(lines, language, theme));
};
