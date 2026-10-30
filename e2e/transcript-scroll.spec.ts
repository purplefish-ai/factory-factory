import { expect, type Locator, test } from '@playwright/test';

function gap(viewport: Locator) {
  return viewport.evaluate((element) =>
    Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
  );
}

test('engine start anchoring never implicitly follows same-key growth', async ({ page }) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Grow engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeGreaterThanOrEqual(199);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(top);
});

test('engine native end anchoring follows append and same-key growth', async ({ page }) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'Toggle native follow', exact: true }).click();
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Append engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Grow engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('transcript follows a burst of output', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await page.getByRole('button', { name: 'Jump latest', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});
