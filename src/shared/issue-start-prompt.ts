export const FACTORY_SIGNATURE = '🏭 Forged in [Factory Factory](https://factoryfactory.ai)';

type IssueStartPromptParams = {
  url: string;
};

export function buildIssueStartPrompt({ url }: IssueStartPromptParams): string {
  return `Fetch and address this issue: ${url}\n\nCreate a PR when done.`;
}
