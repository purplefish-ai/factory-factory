import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repositoryRoot = process.cwd();
const thisFile = 'src/lib/icon-library.test.ts';
const lucidePackage = ['lucide', 'react'].join('-');
const lucideClassPrefix = ['lucide', ''].join('-');
const lucideIconType = ['Lucide', 'Icon'].join('');
const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('icon library', () => {
  it('uses Phosphor without active Lucide references', () => {
    const packageJson = packageJsonSchema.parse(
      JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
    );

    expect(packageJson.dependencies?.['@phosphor-icons/react']).toBeDefined();
    expect(packageJson.dependencies?.[lucidePackage]).toBeUndefined();

    const violations = sourceFiles(join(repositoryRoot, 'src'))
      .filter((path) => relative(repositoryRoot, path) !== thisFile)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return source.includes(lucidePackage) ||
          source.includes(lucideIconType) ||
          source.includes(lucideClassPrefix)
          ? [relative(repositoryRoot, path)]
          : [];
      });

    expect(violations).toEqual([]);

    const iconGuidance = readFileSync(
      join(repositoryRoot, 'docs/design/ratchet-ux-simplification-plan.md'),
      'utf8'
    );
    expect(iconGuidance).not.toContain(lucidePackage);
  });
});
