const { test, expect } = require('@playwright/test');

async function joinAs(page, firstName) {
  await page.goto('/');
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.locator('[data-testid="pick"][data-first="' + firstName + '"]').click();
  await expect(page.getByTestId('join-btn')).toBeEnabled();
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('boardroom')).toContainText(firstName);
}

async function leave(page) {
  const link = page.getByTestId('leave-link');
  if (await link.isVisible().catch(() => false)) {
    await link.click();
  }
}

test.describe('Planning Poker — Business Wife Edition', () => {
  test('home shows title and 16 wife portraits', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Business Wife Edition/);
    await expect(page.locator('h1')).toContainText('Business Wife Edition');
    await expect(page.getByTestId('join-screen')).toBeVisible();

    const picks = page.locator('[data-testid="pick"]');
    await expect(picks).toHaveCount(16);

    const portraits = page.locator('#nameGrid img.pic');
    await expect(portraits).toHaveCount(16);
    await expect.poll(async () => {
      return portraits.evaluateAll((imgs) =>
        imgs.filter((img) => img.complete && img.naturalWidth > 0).length
      );
    }).toBe(16);
  });

  test('join, vote, reveal, next round', async ({ page }) => {
    await joinAs(page, 'Coco');
    await expect(page.getByTestId('status')).toBeVisible();

    const phase = await page.locator('#phaseBadge').textContent();
    if ((phase || '').includes('revealed')) await page.getByTestId('next-btn').click();
    await page.locator('[data-testid="card"][data-v="8"]').click();
    await expect(page.locator('.player.me .vote')).toHaveText('🔒');

    await page.getByTestId('reveal-btn').click();
    await expect(page.locator('.player.me .vote')).toHaveText('8');
    await expect(page.getByTestId('status')).toContainText('revealed');

    await page.getByTestId('next-btn').click();
    await expect(page.locator('.player.me .vote')).toHaveText('—');

    await leave(page);
    await expect(page.getByTestId('join-screen')).toBeVisible();
  });

  test('two wives vote live and both see the reveal', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await joinAs(a, 'Vivienne');
    await joinAs(b, 'Betty');

    await expect(a.getByTestId('boardroom')).toContainText('Betty');
    await expect(b.getByTestId('boardroom')).toContainText('Vivienne');

    await a.locator('[data-testid="card"][data-v="5"]').click();
    await b.locator('[data-testid="card"][data-v="13"]').click();

    await expect(a.locator('.player.me.voted')).toBeVisible();
    await expect(b.locator('.player.me.voted')).toBeVisible();
    await expect(a.getByTestId('status')).toContainText('Reveal');

    await a.getByTestId('reveal-btn').click();
    await expect(a.locator('.player.me .vote')).toHaveText('5');
    await expect(b.locator('.player.me .vote')).toHaveText('13');
    await expect(a.getByTestId('boardroom')).toContainText('13');
    await expect(b.getByTestId('boardroom')).toContainText('5');

    await leave(a);
    await leave(b);
    await ctxA.close();
    await ctxB.close();
  });
});
