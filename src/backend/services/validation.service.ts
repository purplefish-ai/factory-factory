/**
 * Validation Service
 *
 * Provides input validation, sanitization, and edge case detection
 * for epics, tasks, and other user inputs.
 */

import { createLogger } from './logger.service.js';

const logger = createLogger('validation');

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: Record<string, unknown>;
}

/**
 * Epic design validation result
 */
export interface EpicDesignValidation extends ValidationResult {
  designQuality: 'insufficient' | 'minimal' | 'adequate' | 'detailed';
  estimatedTaskCount: number;
  needsClarification: boolean;
  clarificationQuestions: string[];
}

/**
 * Git branch name validation result
 */
export interface BranchNameValidation extends ValidationResult {
  sanitizedBranchName: string;
}

/**
 * Minimum requirements for epic designs
 */
const EPIC_DESIGN_MIN_WORDS = 20;
const EPIC_DESIGN_ADEQUATE_WORDS = 50;
const EPIC_DESIGN_DETAILED_WORDS = 100;

/**
 * Forbidden patterns for security
 */
const FORBIDDEN_PATTERNS = [
  // Script injection
  /<script\b[^>]*>/i,
  /<\/script>/i,
  /javascript:/i,
  /on\w+\s*=/i,

  // SQL injection patterns
  /'\s*or\s+'1'\s*=\s*'1/i,
  /'\s*;\s*drop\s+table/i,
  /'\s*;\s*delete\s+from/i,
  /union\s+select/i,

  // Command injection patterns
  /;\s*rm\s+-rf/i,
  /\|\s*rm\s+/i,
  /`[^`]*`/,
  /\$\([^)]*\)/,

  // Path traversal
  /\.\.\//,
  /\.\.\\/,
];

/**
 * Sanitize a string for safe use
 */
function sanitizeString(input: string): string {
  if (!input) return '';

  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length to prevent DoS
  if (sanitized.length > 10000) {
    sanitized = sanitized.substring(0, 10000);
  }

  return sanitized;
}

/**
 * Check for forbidden patterns
 */
function containsForbiddenPatterns(input: string): string[] {
  const found: string[] = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(input)) {
      found.push(pattern.source);
    }
  }

  return found;
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * ValidationService class
 */
export class ValidationService {
  /**
   * Validate and sanitize epic title
   */
  validateEpicTitle(title: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitized = sanitizeString(title);

    if (!sanitized) {
      errors.push('Epic title is required');
    } else if (sanitized.length < 3) {
      errors.push('Epic title must be at least 3 characters');
    } else if (sanitized.length > 200) {
      warnings.push('Epic title is very long, consider shortening');
    }

    const forbidden = containsForbiddenPatterns(sanitized);
    if (forbidden.length > 0) {
      errors.push('Epic title contains potentially dangerous content');
      logger.warn('Forbidden patterns detected in epic title', { patterns: forbidden });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: { title: sanitized },
    };
  }

  /**
   * Validate and analyze epic design/description
   */
  validateEpicDesign(description: string | undefined): EpicDesignValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const clarificationQuestions: string[] = [];

    const sanitized = sanitizeString(description || '');
    const wordCount = countWords(sanitized);

    // Check for forbidden patterns
    const forbidden = containsForbiddenPatterns(sanitized);
    if (forbidden.length > 0) {
      errors.push('Epic description contains potentially dangerous content');
      logger.warn('Forbidden patterns detected in epic description', { patterns: forbidden });
    }

    // Determine design quality
    let designQuality: 'insufficient' | 'minimal' | 'adequate' | 'detailed';
    let estimatedTaskCount = 0;
    let needsClarification = false;

    if (wordCount < EPIC_DESIGN_MIN_WORDS) {
      designQuality = 'insufficient';
      needsClarification = true;
      clarificationQuestions.push('Can you provide more details about what this epic should accomplish?');
      clarificationQuestions.push('What are the main features or changes needed?');
      warnings.push(`Epic design is too brief (${wordCount} words, minimum ${EPIC_DESIGN_MIN_WORDS})`);
    } else if (wordCount < EPIC_DESIGN_ADEQUATE_WORDS) {
      designQuality = 'minimal';
      estimatedTaskCount = Math.max(1, Math.floor(wordCount / 15));
      clarificationQuestions.push('Are there any specific requirements or constraints?');
      warnings.push('Epic design could use more detail');
    } else if (wordCount < EPIC_DESIGN_DETAILED_WORDS) {
      designQuality = 'adequate';
      estimatedTaskCount = Math.max(2, Math.floor(wordCount / 20));
    } else {
      designQuality = 'detailed';
      estimatedTaskCount = Math.max(3, Math.floor(wordCount / 25));
    }

    // Check for common missing information
    const lowerDesc = sanitized.toLowerCase();

    if (!lowerDesc.includes('test') && !lowerDesc.includes('verify')) {
      clarificationQuestions.push('Should tests be included for this feature?');
    }

    if (!lowerDesc.includes('error') && !lowerDesc.includes('fail') && !lowerDesc.includes('exception')) {
      clarificationQuestions.push('How should errors be handled?');
    }

    return {
      isValid: errors.length === 0 && designQuality !== 'insufficient',
      errors,
      warnings,
      sanitized: { description: sanitized },
      designQuality,
      estimatedTaskCount,
      needsClarification,
      clarificationQuestions: clarificationQuestions.slice(0, 3), // Max 3 questions
    };
  }

  /**
   * Validate task title
   */
  validateTaskTitle(title: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitized = sanitizeString(title);

    if (!sanitized) {
      errors.push('Task title is required');
    } else if (sanitized.length < 3) {
      errors.push('Task title must be at least 3 characters');
    } else if (sanitized.length > 200) {
      warnings.push('Task title is very long, consider shortening');
    }

    const forbidden = containsForbiddenPatterns(sanitized);
    if (forbidden.length > 0) {
      errors.push('Task title contains potentially dangerous content');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: { title: sanitized },
    };
  }

  /**
   * Validate task description
   */
  validateTaskDescription(description: string | undefined): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitized = sanitizeString(description || '');

    if (!sanitized) {
      warnings.push('Task has no description, worker may need more context');
    }

    const forbidden = containsForbiddenPatterns(sanitized);
    if (forbidden.length > 0) {
      errors.push('Task description contains potentially dangerous content');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: { description: sanitized },
    };
  }

  /**
   * Validate and sanitize git branch name
   */
  validateBranchName(name: string): BranchNameValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    let sanitized = sanitizeString(name);

    // Replace invalid characters
    sanitized = sanitized
      .toLowerCase()
      .replace(/[^a-z0-9\-_/]/g, '-') // Replace invalid chars with dash
      .replace(/--+/g, '-') // Remove consecutive dashes
      .replace(/^-|-$/g, '') // Remove leading/trailing dashes
      .substring(0, 100); // Limit length

    // Ensure it doesn't start with a slash or end with .lock
    if (sanitized.startsWith('/')) {
      sanitized = sanitized.substring(1);
    }
    if (sanitized.endsWith('.lock')) {
      sanitized = sanitized.slice(0, -5);
    }

    if (!sanitized) {
      errors.push('Branch name cannot be empty after sanitization');
      sanitized = `branch-${Date.now()}`;
    }

    if (sanitized !== name.toLowerCase()) {
      warnings.push(`Branch name was sanitized from "${name}" to "${sanitized}"`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitizedBranchName: sanitized,
    };
  }

  /**
   * Validate file path (for worktree operations)
   */
  validateFilePath(path: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitized = sanitizeString(path);

    // Check for path traversal
    if (sanitized.includes('..')) {
      errors.push('Path contains path traversal characters');
    }

    // Check for null bytes
    if (path.includes('\0')) {
      errors.push('Path contains null bytes');
    }

    // Check for absolute paths outside allowed directories
    if (sanitized.startsWith('/') && !sanitized.startsWith('/tmp/')) {
      warnings.push('Absolute path used - ensure this is intentional');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: { path: sanitized },
    };
  }

  /**
   * Validate mail content
   */
  validateMailContent(subject: string, body: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitizedSubject = sanitizeString(subject);
    const sanitizedBody = sanitizeString(body);

    if (!sanitizedSubject) {
      errors.push('Mail subject is required');
    } else if (sanitizedSubject.length > 200) {
      warnings.push('Mail subject is very long');
    }

    if (!sanitizedBody) {
      errors.push('Mail body is required');
    }

    // Check for potentially malicious content
    const forbiddenInSubject = containsForbiddenPatterns(sanitizedSubject);
    const forbiddenInBody = containsForbiddenPatterns(sanitizedBody);

    if (forbiddenInSubject.length > 0 || forbiddenInBody.length > 0) {
      errors.push('Mail content contains potentially dangerous patterns');
      logger.warn('Forbidden patterns detected in mail', {
        subject: forbiddenInSubject,
        body: forbiddenInBody,
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: {
        subject: sanitizedSubject,
        body: sanitizedBody,
      },
    };
  }

  /**
   * Detect duplicate tasks
   */
  checkForDuplicateTask(
    newTitle: string,
    existingTasks: { id: string; title: string }[]
  ): { isDuplicate: boolean; similarTasks: { id: string; title: string; similarity: number }[] } {
    const normalizedNew = newTitle.toLowerCase().trim();
    const similarTasks: { id: string; title: string; similarity: number }[] = [];

    for (const task of existingTasks) {
      const normalizedExisting = task.title.toLowerCase().trim();

      // Check for exact match
      if (normalizedNew === normalizedExisting) {
        return {
          isDuplicate: true,
          similarTasks: [{ ...task, similarity: 1.0 }],
        };
      }

      // Check for high similarity (simple word overlap)
      const newWords = new Set(normalizedNew.split(/\s+/));
      const existingWords = new Set(normalizedExisting.split(/\s+/));
      const intersection = new Set([...newWords].filter((x) => existingWords.has(x)));
      const union = new Set([...newWords, ...existingWords]);
      const similarity = intersection.size / union.size;

      if (similarity > 0.7) {
        similarTasks.push({ ...task, similarity });
      }
    }

    return {
      isDuplicate: false,
      similarTasks: similarTasks.sort((a, b) => b.similarity - a.similarity).slice(0, 3),
    };
  }

  /**
   * Validate Linear issue URL
   */
  validateLinearIssueUrl(url: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sanitized = sanitizeString(url);

    if (!sanitized) {
      // URL is optional
      return { isValid: true, errors, warnings };
    }

    // Check if it looks like a Linear URL
    if (!sanitized.startsWith('https://linear.app/')) {
      warnings.push('URL does not appear to be a Linear issue URL');
    }

    // Basic URL validation
    try {
      new URL(sanitized);
    } catch {
      errors.push('Invalid URL format');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: { url: sanitized },
    };
  }
}

// Export singleton instance
export const validationService = new ValidationService();
