/**
 * Conversation Analyzer Utilities
 *
 * Extracts key topics and generates branch name suggestions from conversation history.
 */

import type { HistoryMessage } from '../claude/session';

/**
 * Extract key topics from conversation history for branch naming.
 * Uses simple keyword extraction and frequency analysis.
 */
export function extractKeyTopics(history: HistoryMessage[]): string {
  // Filter to user messages only (they contain the actual work intent)
  const userMessages = history.filter((m) => m.type === 'user');

  if (userMessages.length === 0) {
    return '';
  }

  // Combine all user message content
  const allText = userMessages.map((m) => m.content).join(' ');

  // Common words to exclude (stop words)
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'as',
    'is',
    'was',
    'are',
    'were',
    'been',
    'be',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'can',
    'may',
    'might',
    'must',
    'this',
    'that',
    'these',
    'those',
    'i',
    'you',
    'he',
    'she',
    'it',
    'we',
    'they',
    'me',
    'him',
    'her',
    'us',
    'them',
    'my',
    'your',
    'his',
    'its',
    'our',
    'their',
    'please',
    'thanks',
    'thank',
    'help',
    'need',
    'want',
    'like',
  ]);

  // Extract words (alphanumeric sequences)
  const words = allText.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) || [];

  // Count word frequencies
  const wordFreq = new Map<string, number>();
  for (const word of words) {
    if (!stopWords.has(word)) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }

  // Get top 5 most frequent words
  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  // Look for technical patterns that are often important
  const technicalPatterns = [
    /\b(react|vue|angular|svelte|nextjs|nuxt)\b/i,
    /\b(typescript|javascript|python|rust|go|java)\b/i,
    /\b(api|rest|graphql|websocket)\b/i,
    /\b(database|db|sql|postgres|mysql|mongodb)\b/i,
    /\b(auth|authentication|login|oauth)\b/i,
    /\b(test|testing|unit|integration|e2e)\b/i,
    /\b(bug|fix|issue|error)\b/i,
    /\b(feature|implement|add)\b/i,
    /\b(refactor|cleanup|optimize)\b/i,
    /\b(ui|ux|component|layout)\b/i,
  ];

  const technicalTerms: string[] = [];
  for (const pattern of technicalPatterns) {
    const match = allText.match(pattern);
    if (match) {
      technicalTerms.push(match[0].toLowerCase());
    }
  }

  // Combine technical terms with top words, prioritizing technical terms
  const keywords = [...new Set([...technicalTerms, ...topWords])].slice(0, 4);

  return keywords.join(', ');
}

/**
 * Count user messages in history (excluding system content).
 */
export function countUserMessages(history: HistoryMessage[]): number {
  return history.filter((m) => m.type === 'user').length;
}
