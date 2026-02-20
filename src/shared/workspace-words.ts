/**
 * Fun words for workspace names.
 * Pick one randomly, append a number if there's a conflict.
 */
export const WORKSPACE_WORDS = [
  // Animals
  'tiger',
  'falcon',
  'otter',
  'panda',
  'wolf',
  'fox',
  'bear',
  'hawk',
  'owl',
  'raven',
  'dolphin',
  'eagle',
  'lynx',
  'cobra',
  'jaguar',
  'panther',
  'phoenix',
  'dragon',
  'griffin',
  'sphinx',
  // Space
  'nova',
  'comet',
  'nebula',
  'quasar',
  'pulsar',
  'orbit',
  'cosmos',
  'stellar',
  'lunar',
  'solar',
  // Elements/Nature
  'thunder',
  'blaze',
  'frost',
  'storm',
  'ember',
  'crystal',
  'aurora',
  'summit',
  'canyon',
  'ridge',
  // Tech/Abstract
  'pixel',
  'vector',
  'cipher',
  'spark',
  'pulse',
  'flux',
  'apex',
  'vertex',
  'nexus',
  'prism',
];

const WORKSPACE_NAME_MAX_LENGTH = 50;

const PROMPT_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'help',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'should',
  'task',
  'that',
  'the',
  'this',
  'to',
  'we',
  'with',
  'work',
  'you',
]);

function normalizeWorkspaceName(name: string): string {
  return name.trim().toLowerCase();
}

function sanitizeWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, WORKSPACE_NAME_MAX_LENGTH)
    .replace(/-+$/g, '');
}

function uniqueNameWithSuffix(baseName: string, existingNames: string[]): string {
  const normalizedExisting = new Set(existingNames.map(normalizeWorkspaceName));
  if (!normalizedExisting.has(normalizeWorkspaceName(baseName))) {
    return baseName;
  }

  const getCandidate = (counter: number): string => {
    const suffix = `-${counter}`;
    const truncatedBase = baseName.slice(0, WORKSPACE_NAME_MAX_LENGTH - suffix.length);
    return `${truncatedBase}${suffix}`;
  };

  let counter = 2;
  const maxIterations = 1000;
  while (counter <= maxIterations) {
    const candidate = getCandidate(counter);
    if (!normalizedExisting.has(normalizeWorkspaceName(candidate))) {
      return candidate;
    }
    counter++;
  }

  // Keep incrementing so we don't return a suffix already known to collide.
  while (true) {
    const candidate = getCandidate(counter);
    if (!normalizedExisting.has(normalizeWorkspaceName(candidate))) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Pick a random word from the list
 */
export function pickRandomWord(): string {
  const selected = WORKSPACE_WORDS[Math.floor(Math.random() * WORKSPACE_WORDS.length)];
  return selected ?? 'workspace';
}

/**
 * Generate a unique workspace name given existing names.
 * Picks a random word, appends a number if there's a conflict.
 */
export function generateUniqueWorkspaceName(existingNames: string[]): string {
  const baseWord = pickRandomWord();

  // Check if the base word is available
  if (!existingNames.includes(baseWord)) {
    return baseWord;
  }

  // Find the next available number (with safety limit)
  let counter = 2;
  const maxIterations = 1000;
  while (counter < maxIterations && existingNames.includes(`${baseWord}-${counter}`)) {
    counter++;
  }

  return `${baseWord}-${counter}`;
}

/**
 * Generate a workspace name from a user prompt.
 * Falls back to random words when prompt does not contain usable tokens.
 */
export function generateWorkspaceNameFromPrompt(prompt: string, existingNames: string[]): string {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const meaningfulWords = words.filter((word) => word.length > 1 && !PROMPT_STOP_WORDS.has(word));
  const selectedWords = (meaningfulWords.length > 0 ? meaningfulWords : words).slice(0, 6);

  const baseName = sanitizeWorkspaceName(selectedWords.join('-'));
  if (!baseName) {
    return generateUniqueWorkspaceName(existingNames);
  }

  return uniqueNameWithSuffix(baseName, existingNames);
}
