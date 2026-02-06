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

/**
 * Pick a random word from the list
 */
export function pickRandomWord(): string {
  // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
  return WORKSPACE_WORDS[Math.floor(Math.random() * WORKSPACE_WORDS.length)]!;
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
