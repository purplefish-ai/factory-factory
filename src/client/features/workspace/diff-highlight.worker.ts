import { tokenizeDiffLines, tokenizeFileContent } from '@/lib/diff/syntax-highlight';
import { diffHighlightRequestSchema, fileHighlightRequestSchema } from './diff-highlight-protocol';

self.onmessage = (event: MessageEvent<unknown>) => {
  const file = fileHighlightRequestSchema.safeParse(event.data);
  if (file.success) {
    self.postMessage(tokenizeFileContent(file.data.content, file.data.language, file.data.theme));
    return;
  }
  const request = diffHighlightRequestSchema.safeParse(event.data);
  if (!request.success) {
    self.postMessage(null);
    return;
  }
  const { lines, language, theme } = request.data;
  self.postMessage(tokenizeDiffLines(lines, language, theme));
};
