import { expect, test } from '@playwright/test';

test('task composer keeps the caret visible after reaching its height cap', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=kanban-inlineworkspaceform--saved-codex-defaults&viewMode=story'
  );
  const input = page.getByRole('textbox');
  // A cold Storybook server compiles this feature on its first browser load.
  await expect(input).toBeEnabled({ timeout: 40_000 });
  await input.fill('A task instruction on each line.\n'.repeat(30));
  await input.press('ControlOrMeta+End');
  await input.evaluate((element) => {
    element.dataset.minimumScrollTop = String(element.scrollTop);
    element.addEventListener('scroll', () => {
      element.dataset.minimumScrollTop = String(
        Math.min(Number(element.dataset.minimumScrollTop), element.scrollTop)
      );
    });
  });
  await input.pressSequentially('Continue typing after the height cap');
  expect(Number(await input.getAttribute('data-minimum-scroll-top'))).toBeGreaterThan(0);
  const geometry = await input.evaluate((element: HTMLTextAreaElement) => ({
    height: element.getBoundingClientRect().height,
    top: element.scrollTop,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(geometry.height).toBe(240);
  expect(geometry.top).toBeGreaterThan(0);
  expect(geometry.gap).toBeLessThanOrEqual(geometry.lineHeight);
  await input.fill('');
  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(64);
});
