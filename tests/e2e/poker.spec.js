const { test, expect } = require('@playwright/test');

async function createRoom(page) {
  await page.goto('/');
  await expect(page.getByTestId('lobby-screen')).toBeVisible();
  await page.getByTestId('create-btn').click();
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await expect(page).toHaveURL(/\/r\/[a-z0-9]{6}/);
  await expect(page.getByTestId('share-url')).toHaveValue(/\/r\/[a-z0-9]{6}/);
  return page.url();
}

async function pickWife(page, firstName) {
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.locator('[data-testid="pick"][data-first="' + firstName + '"]').click();
  await expect(page.getByTestId('join-btn')).toBeEnabled();
  await page.getByTestId('join-btn').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByTestId('boardroom')).toContainText(firstName);
}

async function leave(page) {
  const link = page.getByTestId('leave-link');
  if (await link.isVisible().catch(() => false)) await link.click();
}

test.describe('Planning Poker — rooms', () => {
  test('homepage is create/join, not a single boardroom', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Business Wife Edition/);
    await expect(page.getByTestId('lobby-screen')).toBeVisible();
    await expect(page.getByTestId('create-btn')).toBeVisible();
    await expect(page.getByTestId('join-screen')).toBeHidden();
    await expect(page.getByTestId('game-screen')).toBeHidden();
  });

  test('create room gets a shareable /r/:id URL and portraits', async ({ page }) => {
    await createRoom(page);
    await expect(page.locator('[data-testid="pick"]')).toHaveCount(16);
    await expect.poll(async () =>
      page.locator('#nameGrid img.pic').evaluateAll((imgs) =>
        imgs.filter((img) => img.complete && img.naturalWidth > 0).length
      )
    ).toBe(16);
  });

  test('join via shared URL, vote, reveal, next round', async ({ browser }) => {
    const host = await browser.newPage();
    const roomUrl = await createRoom(host);
    await pickWife(host, 'Coco');

    const guest = await browser.newPage();
    await guest.goto(roomUrl);
    await pickWife(guest, 'Betty');
    await expect(host.getByTestId('boardroom')).toContainText('Betty');

    const phase = await host.locator('#phaseBadge').textContent();
    if ((phase || '').includes('revealed')) await host.getByTestId('next-btn').click();
    await host.locator('[data-testid="card"][data-v="8"]').click();
    await expect(host.locator('.player.me .vote')).toHaveText('🔒');

    await host.getByTestId('reveal-btn').click();
    await expect(host.locator('.player.me .vote')).toHaveText('8');
    await expect(guest.getByTestId('boardroom')).toContainText('8');

    await host.getByTestId('next-btn').click();
    await expect(host.locator('.player.me .vote')).toHaveText('—');

    await leave(host);
    await leave(guest);
  });

  test('two rooms stay isolated', async ({ browser }) => {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await createRoom(a);
    await pickWife(a, 'Vivienne');
    await createRoom(b);
    await pickWife(b, 'Margot');
    await expect(a.getByTestId('boardroom')).not.toContainText('Margot');
    await expect(b.getByTestId('boardroom')).not.toContainText('Vivienne');
    expect(new URL(a.url()).pathname).not.toBe(new URL(b.url()).pathname);
    await leave(a);
    await leave(b);
  });
});
