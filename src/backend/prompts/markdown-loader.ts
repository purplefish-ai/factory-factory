/**
 * Shared markdown file loader with frontmatter parsing.
 *
 * This module provides utilities for loading markdown files with YAML frontmatter,
 * used by both workflows and quick-actions.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Logger interface (matches Logger class from logger.service)
 */
interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Result of parsing frontmatter from markdown content.
 */
export interface FrontmatterResult<T> {
  /** Parsed frontmatter fields */
  frontmatter: T;
  /** Markdown body content (after frontmatter) */
  body: string;
}

/**
 * Configuration for loading markdown files from a directory.
 */
export interface MarkdownLoaderConfig<T> {
  /** Absolute path to the directory containing markdown files */
  directory: string;
  /** Logger instance for logging load operations */
  logger: Logger;
  /** Function to parse a single markdown file into a result object */
  parseFile: (filePath: string, content: string, id: string) => T | null;
}

// =============================================================================
// Frontmatter Parser
// =============================================================================

/**
 * Parse simple YAML frontmatter from markdown content.
 * Only handles basic key: value pairs, not nested structures.
 *
 * @param content - The full markdown content including frontmatter
 * @param fieldParsers - Map of field names to parser functions
 * @returns Parsed frontmatter object and body content
 */
export function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
  fieldParsers: Record<string, (value: string) => unknown>
): FrontmatterResult<T> {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {} as T, body: content };
  }

  const frontmatterText = match[1] as string;
  const body = content.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};

  // Parse each line as key: value (split on \r?\n to handle CRLF)
  for (const line of frontmatterText.split(/\r?\n/)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    // Use field parser if available, otherwise store as string
    if (key in fieldParsers) {
      frontmatter[key] = fieldParsers[key]?.(value);
    }
  }

  return { frontmatter: frontmatter as T, body };
}

// =============================================================================
// File Loading
// =============================================================================

/**
 * Load all markdown files from a directory with caching.
 *
 * @param config - Configuration for loading markdown files
 * @returns Array of parsed file objects
 */
export function createMarkdownLoader<T>(config: MarkdownLoaderConfig<T>) {
  let cache: T[] | null = null;

  return {
    /**
     * Load all markdown files from the configured directory.
     * Results are cached after first call.
     */
    load(): T[] {
      if (cache !== null) {
        config.logger.debug('Returning cached markdown files', {
          count: cache.length,
          dir: config.directory,
        });
        return cache;
      }

      config.logger.info('Loading markdown files from disk', { dir: config.directory });

      try {
        const files = readdirSync(config.directory).filter((f) => f.endsWith('.md'));
        config.logger.info('Found markdown files', { files, dir: config.directory });

        cache = files
          .map((file) => {
            const filePath = join(config.directory, file);
            try {
              const content = readFileSync(filePath, 'utf-8');
              const id = basename(file, '.md');
              return config.parseFile(filePath, content, id);
            } catch (error) {
              config.logger.warn('Failed to load markdown file', {
                filePath,
                error: String(error),
              });
              return null;
            }
          })
          .filter((item): item is T => item !== null);

        config.logger.info('Loaded markdown files', {
          count: cache.length,
          dir: config.directory,
        });

        return cache;
      } catch (error) {
        // Directory doesn't exist or can't be read
        config.logger.error('Failed to load markdown files', {
          dir: config.directory,
          error: String(error),
        });
        cache = [];
        return cache;
      }
    },

    /**
     * Clear the cache (useful for testing or hot reloading).
     */
    clearCache(): void {
      cache = null;
    },
  };
}
