import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MergedPullRequest } from './pull-requests';
import {
  sandboxSectionMetrics,
  sandboxSectionState,
  templateMergedAt,
  templatePlaceholder,
} from './sandbox-section';

const before = '2026-11-13T21:00:00Z';
const after = '2026-11-13T23:00:00Z';

function pullRequest(number: number, body: string, createdAt = after): MergedPullRequest {
  return { number, title: `PR ${number}`, body, createdAt, mergedAt: '2026-11-14T10:00:00Z' };
}

describe('sandboxSectionState', () => {
  it('finds an empty section', () => {
    const body =
      '## What changed\n\nA.\n\n## Driven in the sandbox\n\n   \n\n## Knowledge updated\n\nNone.';
    expect(sandboxSectionState(body)).toBe('empty');
  });

  it('treats comments and the template placeholder as empty', () => {
    expect(
      sandboxSectionState(
        '## Driven in the sandbox\n\n<!-- Evidence.\nOver two lines. -->\n\n## Knowledge updated\n'
      )
    ).toBe('empty');
    expect(
      sandboxSectionState(`## Driven in the sandbox\n\n${templatePlaceholder}\n\n## Next\n`)
    ).toBe('empty');
    expect(
      sandboxSectionState(
        `## Driven in the sandbox\r\n\r\n<!-- ${templatePlaceholder} -->\r\n\r\n## Next\r\n`
      )
    ).toBe('empty');
    // An unclosed comment hides the rest of the section.
    expect(sandboxSectionState('## Driven in the sandbox\n\n<!-- never closed\nreal?')).toBe(
      'empty'
    );
  });

  it('treats the pull request template as empty', () => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8');
    expect(sandboxSectionState(template)).toBe('empty');
    expect(template.replaceAll(/\s+/g, ' ')).toContain(templatePlaceholder);
  });

  it('finds real text, also beside a comment or inside a subsection', () => {
    expect(
      sandboxSectionState('## Driven in the sandbox\n\nDoes not apply: docs only.\n\n## Next\n')
    ).toBe('filled');
    expect(sandboxSectionState('## Driven in the sandbox\n<!-- note --> Ran it.\n## Next\n')).toBe(
      'filled'
    );
    expect(
      sandboxSectionState('## Driven in the sandbox\n\n### Steps\n\nClicked.\n\n## Next\n')
    ).toBe('filled');
  });

  it('reports a missing section', () => {
    expect(sandboxSectionState('')).toBe('missing');
    expect(sandboxSectionState('## What changed\n\nDriven in the sandbox.\n')).toBe('missing');
    expect(sandboxSectionState('## Driven in the sandbox box\n\nText.\n')).toBe('missing');
    // A heading shown in a code block is not a heading.
    expect(sandboxSectionState('```md\n## Driven in the sandbox\n\nText.\n```\n')).toBe('missing');
  });

  it('reads a section that is last in the body, with or without a final newline', () => {
    expect(sandboxSectionState('## Why\n\nB.\n\n## Driven in the sandbox\n\nRan it.')).toBe(
      'filled'
    );
    expect(sandboxSectionState('## Why\n\nB.\n\n## Driven in the sandbox\n')).toBe('empty');
    expect(sandboxSectionState('## Driven in the sandbox')).toBe('empty');
  });

  it('ends the section at the next heading, not at a heading in a code block', () => {
    expect(
      sandboxSectionState('## Driven in the sandbox\n\n## Knowledge updated\n\nTests.\n')
    ).toBe('empty');
    expect(
      sandboxSectionState('## Driven in the sandbox\n\n```\n## output\n```\n\n## Next\n')
    ).toBe('filled');
  });

  it('reads every line ending', () => {
    expect(sandboxSectionState('## Why\rB.\r## Driven in the sandbox\rRan it.\r## Next\rC.')).toBe(
      'filled'
    );
    expect(sandboxSectionState('## Driven in the sandbox\r\r## Next\rC.')).toBe('empty');
  });

  it('ignores headings inside comments', () => {
    expect(sandboxSectionState('<!-- ## Driven in the sandbox -->\nText.\n')).toBe('missing');
    expect(sandboxSectionState('<!--\n## Driven in the sandbox\n-->\n\n## Why\n\nText.\n')).toBe(
      'missing'
    );
    // A heading in a comment does not end the section either.
    expect(
      sandboxSectionState('## Driven in the sandbox\n<!--\n## Next\n-->\nRan it.\n## Why\n')
    ).toBe('filled');
    expect(sandboxSectionState('## Driven in the sandbox <!-- note -->\nRan it.')).toBe('filled');
  });

  it('removes a comment that spans lines without leaving a line break behind', () => {
    const split = templatePlaceholder.replace('user-visible', 'user-vis<!--\nnote\n-->ible');
    expect(sandboxSectionState(`## Driven in the sandbox\n${split}\n`)).toBe('empty');
  });

  it('does not let a comment marker in a fence opener hide later headings', () => {
    expect(
      sandboxSectionState('```html <!--\ncode\n```\n\n## Driven in the sandbox\n\nRan it.\n')
    ).toBe('filled');
  });

  it('keeps comment markers inside a code fence as text', () => {
    expect(
      sandboxSectionState('## Driven in the sandbox\n\n```html\n<!-- shown\n```\n\n## Next\n')
    ).toBe('filled');
  });

  it('accepts heading variants and treats the body only as text', () => {
    expect(sandboxSectionState('# driven in the SANDBOX #\nRan.\n')).toBe('filled');
    expect(sandboxSectionState('## Driven in the sandbox\n$(rm -rf /) `id` && exit 1')).toBe(
      'filled'
    );
  });

  it('stays fast on pathological bodies', () => {
    const started = Date.now();
    sandboxSectionState(
      `## Driven in the sandbox\n${' '.repeat(200_000)}\n${'<!--'.repeat(50_000)}`
    );
    sandboxSectionState(`#${' '.repeat(100_000)}x\n${'#'.repeat(100_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('sandboxSectionMetrics', () => {
  it('counts only pull requests opened since the template and reports earlier ones apart', () => {
    const metrics = sandboxSectionMetrics([
      pullRequest(1, '## Driven in the sandbox\n\nRan it.', after),
      pullRequest(2, '## Driven in the sandbox\n\n<!-- placeholder -->\n', after),
      pullRequest(3, 'No sections.', after),
      pullRequest(4, '## Driven in the sandbox\n\nRan it.', after),
      pullRequest(5, 'Old body.', before),
      pullRequest(6, '## Driven in the sandbox\n\nRan it.', before),
    ]);
    expect(metrics).toEqual({
      templateMergedAt,
      beforeTemplate: 2,
      sinceTemplate: 4,
      filled: 2,
      empty: 1,
      missing: 1,
      shareFilled: 0.5,
      unfilledNumbers: [2, 3],
    });
  });

  it('counts a pull request opened exactly when the template merged', () => {
    expect(sandboxSectionMetrics([pullRequest(1, 'x', templateMergedAt)])).toMatchObject({
      beforeTemplate: 0,
      sinceTemplate: 1,
    });
  });

  it('has no share when no pull request is eligible', () => {
    expect(sandboxSectionMetrics([pullRequest(1, 'x', before)])).toMatchObject({
      sinceTemplate: 0,
      shareFilled: null,
      unfilledNumbers: [],
    });
    expect(sandboxSectionMetrics([])).toMatchObject({ beforeTemplate: 0, shareFilled: null });
  });
});
