/**
 * Guidelines section generator
 *
 * Generates DO/DON'T guidelines sections.
 */

import type { GuidelinesConfig } from '../types.js';

/**
 * Generate a guidelines section with DO and DON'T lists
 */
export function generateGuidelines(config: GuidelinesConfig): string {
  const dosSection = config.dos.map((item) => `- ${item}`).join('\n');
  const dontsSection = config.donts.map((item) => `- ${item}`).join('\n');

  return `## Important Guidelines

### DO:
${dosSection}

### DON'T:
${dontsSection}`;
}
