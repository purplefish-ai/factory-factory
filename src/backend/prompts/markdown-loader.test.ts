import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './markdown-loader';

// =============================================================================
// parseFrontmatter Tests
// =============================================================================

describe('parseFrontmatter', () => {
  it('should parse basic frontmatter fields', () => {
    const content = `---
name: Test Document
description: A test markdown file
version: 1.0
---

# Content

This is the body.`;

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
      version: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: 'Test Document',
      description: 'A test markdown file',
      version: '1.0',
    });
    expect(result.body).toBe('\n# Content\n\nThis is the body.');
  });

  it('should handle boolean values', () => {
    const content = `---
enabled: true
disabled: false
---

Body content`;

    const result = parseFrontmatter(content, {
      enabled: (v) => v === 'true',
      disabled: (v) => v === 'true',
    });

    expect(result.frontmatter).toEqual({
      enabled: true,
      disabled: false,
    });
  });

  it('should handle numeric values', () => {
    const content = `---
count: 42
percentage: 3.14
---

Body content`;

    const result = parseFrontmatter(content, {
      count: (v) => Number.parseInt(v, 10),
      percentage: (v) => Number.parseFloat(v),
    });

    expect(result.frontmatter).toEqual({
      count: 42,
      percentage: 3.14,
    });
  });

  it('should return empty frontmatter if no frontmatter present', () => {
    const content = '# Just content\n\nNo frontmatter here.';

    const result = parseFrontmatter(content, {
      name: (v) => v,
    });

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('should ignore fields not in fieldParsers', () => {
    const content = `---
name: Test
ignored: This should be ignored
description: Test description
alsoIgnored: Also ignored
---

Body`;

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: 'Test',
      description: 'Test description',
    });
    expect(result.frontmatter).not.toHaveProperty('ignored');
    expect(result.frontmatter).not.toHaveProperty('alsoIgnored');
  });

  it('should handle Windows line endings (CRLF)', () => {
    const content = '---\r\nname: Test\r\ndescription: Windows\r\n---\r\n\r\nBody content';

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: 'Test',
      description: 'Windows',
    });
    expect(result.body).toBe('\r\nBody content');
  });

  it('should parse boolean values correctly with CRLF line endings', () => {
    const content = '---\r\nenabled: true\r\ndisabled: false\r\n---\r\nBody';

    const result = parseFrontmatter(content, {
      enabled: (v) => v === 'true',
      disabled: (v) => v === 'true',
    });

    expect(result.frontmatter).toEqual({
      enabled: true,
      disabled: false,
    });
  });

  it('should handle empty frontmatter block', () => {
    const content = '---\n\n---\nBody content';

    const result = parseFrontmatter(content, {
      name: (v) => v,
    });

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body content');
  });

  it('should handle lines without colons', () => {
    const content = `---
name: Valid
This line has no colon
description: Also valid
---

Body`;

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: 'Valid',
      description: 'Also valid',
    });
  });

  it('should trim whitespace from keys and values', () => {
    const content = `---
  name:   Test Document
description:Test Description
---

Body`;

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: 'Test Document',
      description: 'Test Description',
    });
  });

  it('should handle empty values', () => {
    const content = `---
name:
description: Has value
---

Body`;

    const result = parseFrontmatter(content, {
      name: (v) => v,
      description: (v) => v,
    });

    expect(result.frontmatter).toEqual({
      name: '',
      description: 'Has value',
    });
  });

  it('should preserve body content after frontmatter', () => {
    const content = `---
title: Test
---

# Heading

Paragraph with **bold** and *italic*.

- List item 1
- List item 2

Code block:
\`\`\`js
console.log('test');
\`\`\``;

    const result = parseFrontmatter(content, {
      title: (v) => v,
    });

    expect(result.body).toContain('# Heading');
    expect(result.body).toContain('**bold**');
    expect(result.body).toContain('console.log');
  });
});
