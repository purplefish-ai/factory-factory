import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await expect(
    page.getByRole('alert').filter({ hasText: 'Missing hover fixture operation:' })
  ).toHaveCount(0);
});

for (const width of [375, 820]) {
  test.describe(`touch actions at ${width}px`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 900 } });
    test('all secondary actions are visible before tapping', async ({ page }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      await expect(
        page.getByRole('button', { name: 'Copy message to clipboard', exact: true })
      ).toHaveCount(0);
      for (const name of [
        'Rename workspace',
        'Archive workspace',
        'Quick Chat',
        'Rewind files to before this message',
        'Delete screenshot Home',
        'Close File',
        'Sidebar action',
        'Remove queued message',
        'Close Inactive',
      ]) {
        const actions = page.getByRole('button', { name, exact: true });
        await expect(actions.first()).toBeAttached();
        for (const action of await actions.all()) {
          await expect(action).toHaveCSS('opacity', '1');
          // Opacity on an ancestor also hides otherwise visible buttons.
          await expect
            .poll(() =>
              action.evaluate((element) => {
                let opacity = 1;
                for (let node: Element | null = element; node; node = node.parentElement) {
                  opacity *= Number(getComputedStyle(node).opacity);
                }
                return opacity;
              })
            )
            .toBe(1);
        }
      }
      await expect(page.locator('[data-slot=scroll-area-scrollbar]')).toHaveCSS('opacity', '1');
      const sidebar = page.getByRole('button', { name: 'Sidebar action' });
      await expect
        .poll(() => sidebar.evaluate((el) => getComputedStyle(el, '::after').display))
        .toBe('block');
    });

    test('icon controls and close actions have 36px touch targets', async ({ page }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      for (const name of [
        'Rename workspace',
        'Archive workspace',
        'Close File',
        'Close Inactive',
        'Delete screenshot Home',
      ]) {
        const control = page.getByRole('button', { name, exact: true }).first();
        await expect(control).toBeVisible();
        const bounds = await control.boundingBox();
        expect(bounds?.width, name).toBeGreaterThanOrEqual(36);
        expect(bounds?.height, name).toBeGreaterThanOrEqual(36);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      ).toBeLessThanOrEqual(1);
    });

    test('kanban controls stay compact without shrinking touch targets', async ({ page }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      const rename = page.getByRole('button', { name: 'Rename workspace', exact: true });
      await expect(rename).toBeVisible();
      const actions = rename.locator('..');
      const bounds = await actions.locator('button').evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, right, width, height } = button.getBoundingClientRect();
          return { x, right, width, height };
        })
      );
      expect(bounds).toHaveLength(4);
      for (const [index, box] of bounds.entries()) {
        expect(box.width).toBeGreaterThanOrEqual(36);
        expect(box.height).toBeGreaterThanOrEqual(36);
        const previous = bounds[index - 1];
        if (previous) {
          // Keep distinct tap areas, with no extra space between them.
          expect(box.x - previous.right).toBeGreaterThanOrEqual(0);
          expect(box.x - previous.right).toBeLessThanOrEqual(1);
        }
      }
    });

    test('screenshot deletion removes the thumbnail', async ({ page }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      await page.getByRole('button', { name: 'Delete screenshot Home' }).tap();
      const confirmation = page.getByRole('alertdialog', { name: 'Delete screenshot?' });
      await expect(confirmation).toBeVisible();
      await expect(page.locator('button[aria-label="Open screenshot Home"]')).toHaveCount(1);
      await confirmation.getByRole('button', { name: 'Delete', exact: true }).tap();
      await expect(page.getByRole('button', { name: 'Open screenshot Home' })).toHaveCount(0);
      await expect(page.getByText('No screenshots yet', { exact: true })).toBeVisible();
    });

    test('archive confirmation, rename, queue removal and terminal closing respond to taps', async ({
      page,
    }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      await page.getByRole('button', { name: 'Archive workspace', exact: true }).tap();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await page.getByRole('button', { name: 'Remove queued message' }).tap();
      await expect(page.getByText('Pending prompt')).toHaveCount(0);
      await page.getByRole('button', { name: 'Close Inactive' }).tap();
      await expect(page.getByRole('button', { name: 'Close Inactive' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Rename workspace' }).tap();
      await expect(page.getByRole('textbox', { name: 'Workspace name' })).toBeVisible();
    });
  });
}

test('desktop actions reveal on hover and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/__mobile-baseline?surface=hover-actions');
  await expect(
    page.getByRole('button', { name: 'Copy message to clipboard', exact: true })
  ).toHaveCount(0);
  for (const text of ['User prompt', 'Assistant response']) {
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  const rename = page.getByRole('button', { name: 'Rename workspace' });
  await expect(rename).toHaveCSS('opacity', '0');
  await rename.focus();
  await expect(rename).toHaveCSS('opacity', '1');
  await rename.blur();
  const rewind = page.getByRole('button', { name: 'Rewind files to before this message' });
  await rewind.focus();
  await expect(rewind.locator('..')).toHaveCSS('opacity', '1');
  const sidebar = page.getByRole('button', { name: 'Sidebar action' });
  await sidebar.focus();
  await expect(sidebar).toHaveCSS('opacity', '1');
  await sidebar.blur();
  await page.getByText('Add user authentication', { exact: true }).hover();
  await expect(rename).toHaveCSS('opacity', '1');
});

// Chromium cannot emulate a secondary coarse pointer alongside a fine primary pointer.
// Override just that media feature in the loaded CSS, leaving desktop hover/fine
// queries active, to exercise the hybrid-device cascade.
test('a secondary coarse pointer keeps desktop-width actions and hit areas visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/__mobile-baseline?surface=hover-actions');
  const rename = page.getByRole('button', { name: 'Rename workspace' });
  await expect(rename).toHaveCSS('opacity', '0');
  const overrides = await page.evaluate(() => {
    let count = 0;
    function override(rules: CSSRuleList) {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('any-pointer: coarse')) {
          rule.media.mediaText = rule.conditionText.replaceAll(
            '(any-pointer: coarse)',
            '(min-width: 0px)'
          );
          count += 1;
        }
        if ('cssRules' in rule) {
          override((rule as CSSGroupingRule).cssRules);
        }
      }
    }
    // Vite injects the app CSS inline; avoid unrelated external font sheets.
    const sheet = Array.from(document.styleSheets).find((sheet) =>
      sheet.ownerNode?.textContent?.includes('.hover-reveal')
    );
    if (!sheet) {
      throw new Error('App styles not loaded');
    }
    override(sheet.cssRules);
    return count;
  });
  expect(overrides).toBeGreaterThan(0);
  await expect(rename).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: 'Archive workspace', exact: true })).toHaveCSS(
    'opacity',
    '1'
  );
  const sidebar = page.getByRole('button', { name: 'Sidebar action' });
  await expect(sidebar).toHaveCSS('opacity', '1');
  await expect
    .poll(() => sidebar.evaluate((el) => getComputedStyle(el, '::after').display))
    .toBe('block');
  await expect(page.locator('[data-slot=scroll-area-scrollbar]')).toHaveCSS('opacity', '1');
});
