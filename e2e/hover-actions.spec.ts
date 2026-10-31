import { expect, test } from '@playwright/test';

for (const width of [375, 820]) {
  test.describe(`touch actions at ${width}px`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 900 } });
    test('actions are visible before tapping and perform their intended action', async ({
      page,
    }) => {
      await page.goto('/__mobile-baseline?surface=hover-actions');
      for (const name of [
        'Rename workspace',
        'Archive workspace',
        'Quick Chat',
        'Copy message to clipboard',
        'Rewind files to before this message',
        'Delete screenshot Home',
        'Close File',
        'Sidebar action',
        'Remove queued message',
        'Close Inactive',
      ]) {
        const action = page.getByRole('button', { name, exact: true }).first();
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
      await expect(page.locator('[data-slot=scroll-area-scrollbar]')).toHaveCSS('opacity', '1');
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
