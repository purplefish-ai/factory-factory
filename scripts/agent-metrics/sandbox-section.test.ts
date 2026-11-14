import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MergedPullRequest } from './pull-requests';
import {
  keywordInstructionMarker,
  sandboxSectionLabel,
  sandboxSectionMetrics,
  sandboxSectionState,
  templateMergedAt,
  templatePath,
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
    const template = readFileSync(templatePath, 'utf8');
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

// Written as code points: a source file should not carry invisible characters.
const zeroWidth = String.fromCodePoint(0x20_0b);
const zeroWidthCharacters = [0x20_0b, 0x20_0c, 0x20_0d, 0x20_60, 0xfe_ff]
  .map((codePoint) => String.fromCodePoint(codePoint))
  .join('');
const attribution = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
const reviewerBlock = [
  '<!-- This is an auto-generated description by cubic. -->',
  '<a href="https://cubic.dev/pr/o/r/pull/1?utm_source=github" target="_blank"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.cubic.dev/buttons/review-in-cubic-dark.svg"><img alt="View guided diff" src="https://www.cubic.dev/buttons/review-in-cubic-light.svg"></picture></a>',
  '<!-- End of auto-generated description by cubic. -->',
].join('\n');

describe('sandboxSectionState with trailing content', () => {
  const last = (section: string) => `## Why\n\nB.\n\n## Driven in the sandbox\n\n${section}`;

  it('ignores a trailing attribution line', () => {
    expect(sandboxSectionState(last(`${attribution}\n`))).toBe('empty');
    expect(sandboxSectionState(last(`<!-- Evidence. -->\n\n${attribution}`))).toBe('empty');
    expect(sandboxSectionState(last(`Ran it.\n\n${attribution}\n`))).toBe('filled');
  });

  it('ignores the block the automated reviewer appends', () => {
    expect(sandboxSectionState(last(`${reviewerBlock}\n`))).toBe('empty');
    expect(sandboxSectionState(last(`${attribution}\n\n\n${reviewerBlock}\n\n`))).toBe('empty');
    expect(sandboxSectionState(last(`Ran it.\n\n${attribution}\n\n${reviewerBlock}\n`))).toBe(
      'filled'
    );
  });

  it('ignores a reviewer block whose closing comment is missing, up to the end of the body', () => {
    expect(sandboxSectionState(last(`${reviewerBlock.split('\n').slice(0, 2).join('\n')}\n`))).toBe(
      'empty'
    );
  });

  it('keeps text after the reviewer block and the text of a section it does not end', () => {
    expect(sandboxSectionState(last(`${reviewerBlock}\nRan it.\n`))).toBe('filled');
    expect(
      sandboxSectionState(`## Driven in the sandbox\n\n${reviewerBlock}\n\n## Knowledge updated\n`)
    ).toBe('empty');
  });

  it('treats a horizontal rule, an empty code fence and zero-width characters as empty', () => {
    for (const rule of ['---', '***', '___', '- - -', '  ----------  ', '* * *']) {
      expect(sandboxSectionState(last(`${rule}\n`)), rule).toBe('empty');
    }
    for (const fence of ['```\n```', '```text\n\n  \n```', '~~~\n~~~', '```\n']) {
      expect(sandboxSectionState(last(`${fence}\n`)), fence).toBe('empty');
    }
    expect(sandboxSectionState(last(`${zeroWidthCharacters}\n`))).toBe('empty');
    expect(sandboxSectionState(last(`${zeroWidth} ---\n\n\`\`\`\n${zeroWidth}\n\`\`\`\n`))).toBe(
      'empty'
    );
  });

  it('finds the section when a zero-width character is in its heading', () => {
    expect(sandboxSectionState(`## Driven${zeroWidth} in the sandbox\n\nRan it.\n`)).toBe('filled');
    expect(sandboxSectionLabel(`## Driven in the sand${zeroWidth}box\n\nDriven: ran it.\n`)).toBe(
      'driven'
    );
  });

  it('keeps a code fence with content and text beside a rule', () => {
    expect(sandboxSectionState(last('```\noutput\n```\n'))).toBe('filled');
    expect(sandboxSectionState(last('---\nRan it.\n'))).toBe('filled');
    expect(sandboxSectionState(last('--\n'))).toBe('filled');
  });

  it('returns on a 200,000-character adversarial body', () => {
    const bodies = [
      `## Driven in the sandbox\n${'<!-- This is an auto-generated description by cubic'.repeat(4000)}`,
      `## Driven in the sandbox\n${`${reviewerBlock}\n`.repeat(500)}`,
      `## Driven in the sandbox\n${'- '.repeat(100_000)}`,
      `## Driven in the sandbox\n${'```\n'.repeat(50_000)}`,
      `## Driven in the sandbox\n\`\`\`\n${'x\n'.repeat(100_000)}`,
      `## Driven in the sandbox\n${zeroWidth.repeat(200_000)}`,
      `## Driven in the sandbox\n${'🤖 Generated with '.repeat(11_000)}`,
      `## Driven in the sandbox\n${'Driven:'.repeat(30_000)}`,
      '## Driven in the sandbox\n'.repeat(8000),
    ];
    for (const body of bodies) {
      expect(body.length).toBeGreaterThanOrEqual(190_000);
      expect(sandboxSectionState(body)).toMatch(/^(empty|filled)$/);
    }
  });
});

describe('sandboxSectionLabel', () => {
  const section = (text: string) =>
    `## Why\n\nB.\n\n## Driven in the sandbox\n\n${text}\n\n## Next\n`;

  it('reads the keyword in any case, after comments, whitespace and rules', () => {
    for (const text of [
      'Driven: ran it.',
      'driven: ran it.',
      'DRIVEN: ran it.',
      '  \n<!-- note -->\n\n  Driven: ran it.',
      '---\nDriven: ran it.',
      `${zeroWidth}Driven:${zeroWidth} ran it.`,
      'Driven:\nran it on the next line.',
    ]) {
      expect(sandboxSectionLabel(section(text)), text).toBe('driven');
    }
    for (const text of [
      'Does not apply: no user-visible behaviour changed.',
      'does NOT apply: docs only.',
      '<!-- x -->Does not apply: docs only.',
      'Does  not\napply: docs only.',
    ]) {
      expect(sandboxSectionLabel(section(text)), text).toBe('not-applicable');
    }
  });

  it('labels text without the keyword at its start as unlabelled', () => {
    for (const text of [
      'Not driven in `pnpm dev:sandbox`.',
      'Ran `pnpm test:e2e:sandbox`.',
      'Not applicable. Docs only.',
      'See below. Driven: yes.',
      'Does not apply, docs only.',
      'Driven yes.',
      'Drivenx: yes',
      '**Driven:** ran it.',
    ]) {
      expect(sandboxSectionLabel(section(text)), text).toBe('unlabelled');
    }
  });

  it('labels a keyword with nothing after it, and a section with nothing, as empty', () => {
    for (const text of [
      '',
      '<!-- Driven: -->',
      'Driven:',
      'Does not apply:  \n',
      '---',
      '```\n```',
    ]) {
      expect(sandboxSectionLabel(section(text)), text).toBe('empty');
    }
    expect(sandboxSectionLabel(`## Driven in the sandbox\n\n${attribution}`)).toBe('empty');
    expect(sandboxSectionLabel(`## Driven in the sandbox\n\n${reviewerBlock}`)).toBe('empty');
  });

  it('labels a body without the section as missing', () => {
    expect(sandboxSectionLabel('## Why\n\nDriven: yes.\n')).toBe('missing');
    expect(sandboxSectionLabel('')).toBe('missing');
  });

  it('labels the template and its earlier instruction as empty', () => {
    expect(sandboxSectionLabel(readFileSync(templatePath, 'utf8'))).toBe('empty');
    expect(sandboxSectionLabel(`## Driven in the sandbox\n\n${templatePlaceholder}\n`)).toBe(
      'empty'
    );
    const firstInstruction =
      'Evidence the change was driven in `pnpm dev:sandbox`: what you did and what you saw, with screenshots or output where they help. Or the reason it does not apply, for example: no user-visible behaviour changed.';
    expect(sandboxSectionLabel(`## Driven in the sandbox\n\n<!-- ${firstInstruction} -->\n`)).toBe(
      'empty'
    );
    expect(sandboxSectionLabel(`## Driven in the sandbox\n\n${firstInstruction}\n`)).toBe('empty');
  });

  it('reads the keyword before a trailing attribution line and reviewer block', () => {
    const body = `## Driven in the sandbox\n\nDriven: ran it.\n\n${attribution}\n\n${reviewerBlock}\n`;
    expect(sandboxSectionLabel(body)).toBe('driven');
    expect(sandboxSectionLabel(body.replace('Driven: ran it.', 'Ran it.'))).toBe('unlabelled');
  });

  it('treats a body as text only', () => {
    expect(sandboxSectionLabel('## Driven in the sandbox\n$(rm -rf /) `id` && exit 1')).toBe(
      'unlabelled'
    );
    expect(sandboxSectionLabel('## Driven in the sandbox\nDriven: $(rm -rf /) `id`')).toBe(
      'driven'
    );
  });
});

describe('the pull request template', () => {
  const template = readFileSync(templatePath, 'utf8');

  it('dates the keyword instruction by the keyword the parser reads', () => {
    expect(
      sandboxSectionLabel(`## Driven in the sandbox\n\n${keywordInstructionMarker} docs only.\n`)
    ).toBe('not-applicable');
  });

  it('asks for both keywords, in the section comment', () => {
    const instruction = template.replaceAll(/\s+/g, ' ');
    expect(instruction).toContain(`<!-- ${templatePlaceholder} -->`);
    expect(templatePlaceholder).toContain('"Driven:"');
    expect(templatePlaceholder).toContain('"Does not apply:"');
    expect(templatePlaceholder).toContain(keywordInstructionMarker);
  });
});

describe('sandboxSectionMetrics', () => {
  const keywordAt = '2026-11-14T12:00:00Z';
  const between = '2026-11-14T10:00:00Z';
  const since = '2026-11-14T13:00:00Z';

  it('judges by content from the template to the keyword instruction, then by keyword', () => {
    const metrics = sandboxSectionMetrics(
      [
        // Before the template: not judged.
        pullRequest(1, 'Old body.', before),
        pullRequest(2, '## Driven in the sandbox\n\nDriven: ran it.', before),
        // From the template to the keyword instruction: filled or empty.
        pullRequest(3, '## Driven in the sandbox\n\nRan it.', between),
        pullRequest(4, '## Driven in the sandbox\n\n<!-- placeholder -->\n', between),
        pullRequest(5, 'No sections.', between),
        pullRequest(6, '## Driven in the sandbox\n\nDoes not apply: docs.', after),
        // Since the keyword instruction.
        pullRequest(7, '## Driven in the sandbox\n\nDriven: ran it.', since),
        pullRequest(8, '## Driven in the sandbox\n\nDRIVEN: ran it.', since),
        pullRequest(9, '## Driven in the sandbox\n\nDoes not apply: docs.', since),
        pullRequest(10, '## Driven in the sandbox\n\nRan it.', since),
        pullRequest(11, '## Driven in the sandbox\n\n<!-- placeholder -->\n', since),
        pullRequest(12, 'No sections.', since),
        pullRequest(13, '## Driven in the sandbox\n\nDoes not apply: docs.', since),
      ],
      keywordAt
    );
    expect(metrics).toEqual({
      templateMergedAt,
      keywordInstructionAt: keywordAt,
      beforeTemplate: 2,
      byContent: { opened: 4, filled: 2, empty: 1, missing: 1, shareFilled: 0.5 },
      byKeyword: {
        judged: 7,
        driven: 2,
        notApplicable: 2,
        unlabelled: 1,
        empty: 1,
        missing: 1,
        // Two driven of the five not marked "does not apply".
        shareDriven: 0.4,
        unclassifiedNumbers: [10, 11, 12],
      },
    });
  });

  it('puts the boundaries on the later group', () => {
    const metrics = sandboxSectionMetrics(
      [pullRequest(1, 'x', templateMergedAt), pullRequest(2, 'Driven: x', keywordAt)],
      keywordAt
    );
    expect(metrics).toMatchObject({
      beforeTemplate: 0,
      byContent: { opened: 1 },
      byKeyword: { judged: 1 },
    });
  });

  it('does not count a pull request without the keyword as unlabelled before the instruction', () => {
    const metrics = sandboxSectionMetrics(
      [pullRequest(1, '## Driven in the sandbox\n\nNot driven.', between)],
      keywordAt
    );
    expect(metrics.byKeyword).toMatchObject({ judged: 0, unlabelled: 0, unclassifiedNumbers: [] });
    expect(metrics.byContent).toMatchObject({ opened: 1, filled: 1, shareFilled: 1 });
  });

  it('has no share when nothing is judged or every judged section is not applicable', () => {
    expect(sandboxSectionMetrics([pullRequest(1, 'x', before)], keywordAt)).toMatchObject({
      byContent: { opened: 0, shareFilled: null },
      byKeyword: { judged: 0, shareDriven: null, unclassifiedNumbers: [] },
    });
    expect(sandboxSectionMetrics([], keywordAt)).toMatchObject({
      beforeTemplate: 0,
      byKeyword: { shareDriven: null },
    });
    expect(
      sandboxSectionMetrics(
        [pullRequest(1, '## Driven in the sandbox\n\nDoes not apply: docs.', since)],
        keywordAt
      ).byKeyword
    ).toMatchObject({ judged: 1, notApplicable: 1, shareDriven: null });
  });

  it('counts a driven section as the whole share when nothing else is judged', () => {
    expect(
      sandboxSectionMetrics(
        [pullRequest(1, '## Driven in the sandbox\n\nDriven: ran it.', since)],
        keywordAt
      ).byKeyword
    ).toMatchObject({ driven: 1, shareDriven: 1 });
  });
});
