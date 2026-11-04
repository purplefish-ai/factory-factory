import { expect, test } from '@playwright/test';

test('queued action focus rings fit inside the clipping wrapper', async ({ page }) => {
  // A cold Storybook server compiles the chat dependency graph on first load.
  test.setTimeout(120_000);
  await page.goto(
    '/iframe.html?id=chat-transcript-chattranscript--queued-message-handoff&viewMode=story',
    {
      waitUntil: 'domcontentloaded',
    }
  );
  const dequeue = page.getByRole('button', { name: 'Dequeue message', exact: true });
  await expect(dequeue).toBeVisible({ timeout: 110_000 });
  await dequeue.focus();
  for (const name of ['Steer queued message', 'Cancel queued message']) {
    await page.keyboard.press('Tab');
    const action = page.getByRole('button', { name, exact: true });
    await expect(action).toBeFocused();
    const clearance = await action.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const gaps: number[] = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        if (style.overflowX === 'hidden') {
          gaps.push(button.left - box.left, box.right - button.right);
        }
        if (style.overflowY === 'hidden') {
          gaps.push(button.top - box.top, box.bottom - button.bottom);
        }
      }
      return { focusVisible: element.matches(':focus-visible'), minimum: Math.min(...gaps) };
    });
    expect(clearance.focusVisible).toBe(true);
    expect(clearance.minimum).toBeGreaterThanOrEqual(2);
  }
});
