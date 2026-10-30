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

test('engine compensates a late above-viewport resize after backward input and cancellation', async ({
  page,
}) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await viewport.hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => gap(viewport)).toBeGreaterThan(500);
  const anchor = await viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-row-key]')].find(
      (item) => item.getBoundingClientRect().bottom > top
    );
    return { key: row?.dataset.rowKey, top: row?.getBoundingClientRect().top };
  });
  expect(anchor.key).toBeDefined();
  const spacer = viewport.locator(':scope > div');
  const extent = await spacer.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Grow preceding engine row', exact: true }).click();
  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(extent + 200);
  await expect
    .poll(async () => (await viewport.locator(`[data-row-key="${anchor.key}"]`).boundingBox())?.y)
    .toBe(anchor.top);
  await expect.poll(() => gap(viewport)).toBeGreaterThan(500);
});

test('engine measures a newly mounted row taller than the viewport without shifting its top', async ({
  page,
}) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'Prepend giant engine row', exact: true }).click();
  const row = viewport.locator('[data-row-key="999"]');
  await expect.poll(async () => (await row.boundingBox())?.height).toBe(1200);
  await expect
    .poll(() =>
      viewport.locator(':scope > div').evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBe(4400);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
});
