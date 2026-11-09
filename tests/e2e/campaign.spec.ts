import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const metrics: Record<string, unknown> = {};
async function login(page: Page) {
  await page.goto('/login?next=/campaigns');
  await page.getByLabel('Email address').fill(process.env.SEED_ADMIN_EMAIL ?? 'demo@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.SEED_ADMIN_PASSWORD ?? 'local-demo-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Make room for better conversations.' }),
  ).toBeVisible();
  expect((await (await page.request.get('/api/v1/providers')).json()).simulation).toBe(true);
}
async function compact(page: Page, key: string) {
  const count = await page
    .locator('main input:visible, main textarea:visible, main select:visible')
    .count();
  metrics[key] = count;
  expect(count).toBeLessThanOrEqual(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (page.viewportSize()?.width === 390) {
    await page.setViewportSize({ width: 360, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
  }
}
for (const width of [1440, 390]) {
  test(`minimal Sales and HR flows, conversation and settings at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    // Respect the unchanged server's shared 120 requests/minute gate between viewport runs.
    const budget = await page.request.get('/healthz');
    if (Number(budget.headers()['x-ratelimit-remaining'] ?? 120) < 100) {
      await page.waitForTimeout(
        Math.min(60000, (Number(budget.headers()['x-ratelimit-reset'] ?? 60) + 1) * 1000),
      );
    }
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text());
    });
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await mkdir('output/playwright/legacy-refresh', { recursive: true });
    const shot = async (name: string) => {
      const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
      if (await dismiss.isVisible()) await dismiss.click();
      await page.screenshot({
        path: `output/playwright/legacy-refresh/${name}-${width}.png`,
        fullPage: !['conversation', 'conversation-test', 'conversation-transcript'].includes(name),
      });
    };
    const started = performance.now();
    await login(page);
    await page.evaluate(() => localStorage.clear());
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveCount(
      3,
    );
    expect(await page.locator('.stats > .stat').count()).toBeLessThanOrEqual(3);
    await shot('campaigns');
    const ids: string[] = [];
    for (const type of ['sales', 'hr'] as const) {
      await page.goto('/campaigns/new');
      await page.getByRole('heading', { name: 'Who would you like to reach?' }).waitFor();
      if (type === 'sales') await shot('entry');
      await page
        .getByRole('link', { name: type === 'sales' ? /Sales & Marketing/ : /HR & Recruitment/ })
        .click();
      await page.getByLabel('Company name', { exact: true }).fill(`Synthetic Orbit ${width}`);
      if (type === 'sales')
        await page
          .getByLabel('What are you offering?')
          .fill('Accessible software consulting for small teams.');
      else {
        await page.getByLabel('Job title', { exact: true }).fill('Frontend engineer');
        await page.getByLabel('Location & work mode', { exact: true }).fill('Hyderabad');
        await page.getByLabel('Must-have requirements', { exact: true }).fill('2 years React');
        await page.getByLabel('Must-have requirements', { exact: true }).press('Enter');
      }
      await compact(page, `${width}-${type}-details`);
      await expect(page.locator('.preview-desktop .preview-bubble')).toContainText('AI assistant');
      await shot(`${type}-details`);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page
        .getByLabel(type === 'sales' ? 'Contacts' : 'Candidates', { exact: true })
        .fill(`name,phone\nSynthetic,+12025550${width === 1440 ? '121' : '122'}`);
      await expect(page.getByText('1 valid', { exact: true })).toBeVisible();
      if (type === 'hr') {
        await page.getByRole('button', { name: 'Email', exact: true }).click();
        await page
          .getByLabel('Where should candidates send their resume?')
          .fill('hiring@example.test');
      }
      await compact(page, `${width}-${type}-contacts`);
      await shot(`${type}-contacts`);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page
        .getByRole('checkbox', {
          name: 'I confirm these contacts may be called and I follow telemarketing rules',
        })
        .check();
      await compact(page, `${width}-${type}-review`);
      await expect(page.getByText('10:00–19:00 IST', { exact: false }).first()).toBeVisible();
      await shot(`${type}-review`);
      await page.getByRole('button', { name: 'Launch', exact: true }).click();
      await expect(page).toHaveURL(/\/campaigns\/[^/]+$/);
      ids.push(new URL(page.url()).pathname.split('/').at(-1)!);
      if (type === 'sales')
        metrics[`${width}-login-to-launch-seconds`] = Number(
          ((performance.now() - started) / 1000).toFixed(2),
        );
      if (type === 'sales') expect(metrics[`${width}-login-to-launch-seconds`]).toBeLessThan(120);
    }
    await page.getByRole('tab', { name: 'Candidates', exact: true }).waitFor();
    await shot('campaign');
    await page.getByRole('button', { name: 'Test in browser', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browser test call' });
    await dialog.getByRole('button', { name: 'Start practice', exact: true }).click();
    await expect(dialog.getByText('Is this a good time', { exact: false })).toBeVisible();
    for (const [i, text] of [
      'Yes',
      'yes',
      'Tell me more',
      'No questions',
      'Yes, I agree to follow-up',
    ].entries()) {
      await dialog.getByLabel('Simulated caller response').fill(text);
      await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
      await expect(dialog.locator('.message.caller')).toHaveCount(i + 1);
      await page.waitForTimeout(450);
    }
    await dialog.getByRole('button', { name: 'End conversation', exact: true }).click();
    await expect(dialog.getByText('Call ended', { exact: true })).toBeVisible();
    await expect(
      dialog.locator('details').filter({ has: page.locator('summary', { hasText: 'Details' }) }),
    ).not.toHaveAttribute('open');
    await dialog.evaluate((el) => (el.scrollTop = 0));
    await shot('conversation-test');
    await dialog.getByRole('button', { name: 'Close Browser test call', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Conversations' })
      .click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await shot('conversations');
    await page.getByRole('button', { name: 'Browser test call', exact: true }).first().click();
    const resultDialog = page.getByRole('dialog', { name: 'Conversation', exact: true });
    await expect(resultDialog.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await expect(resultDialog.locator('.lead-card')).toContainText('Saved internally');
    await expect(resultDialog.locator('details')).not.toHaveAttribute('open');
    await resultDialog.evaluate((el) => (el.scrollTop = 0));
    await shot('conversation');
    if (width === 390) {
      await resultDialog.getByRole('region', { name: 'Transcript' }).scrollIntoViewIfNeeded();
      await shot('conversation-transcript');
    }
    await page.keyboard.press('Escape');
    await expect(resultDialog).not.toBeVisible();
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Settings' })
      .click();
    await page.getByRole('heading', { name: 'Make yourself at home.' }).waitFor();
    await shot('settings');
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    const session = await (await page.request.get('/api/v1/auth/me')).json();
    for (const id of ids)
      expect(
        (
          await page.request.delete(`/api/v1/campaigns/${id}`, {
            headers: { 'X-CSRF-Token': session.csrf },
          })
        ).ok(),
      ).toBe(true);
    await mkdir('output/playwright', { recursive: true });
    await writeFile('output/playwright/ui-metrics.json', JSON.stringify(metrics, null, 2));
  });
}
