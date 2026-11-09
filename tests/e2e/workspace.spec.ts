import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
async function budget(page: Page) {
  const r = await page.request.get('/healthz');
  if (Number(r.headers()['x-ratelimit-remaining'] ?? 120) < 105)
    await page.waitForTimeout(
      Math.min(60000, (Number(r.headers()['x-ratelimit-reset'] ?? 60) + 1) * 1000),
    );
}
for (const width of [1440, 390])
  test(`public landing to recruitment, call portal and results at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await budget(page);
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await mkdir('docs/screens-refresh', { recursive: true });
    const ids: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', async (response) => {
      if (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/campaigns' &&
        response.ok()
      ) {
        const row = await response.json();
        ids.push(row.id);
      }
    });
    const shot = async (name: string, fullPage = true) => {
      const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
      if (await dismiss.isVisible()) await dismiss.click();
      await page.screenshot({ path: `docs/screens-refresh/${name}-${width}.png`, fullPage });
    };
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 390) {
        await page.setViewportSize({ width: 360, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.setViewportSize({ width: 390, height: 844 });
      }
    };
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        'Your Entire Business Communication,',
      );
      await fits();
      await shot('landing');
      await page
        .locator('.marketing-actions')
        .getByRole('link', { name: 'Sign in', exact: true })
        .click();
      await shot('login');
      await page
        .getByLabel('Email address')
        .fill(process.env.SEED_ADMIN_EMAIL ?? 'demo@example.test');
      await page
        .getByLabel('Password', { exact: true })
        .fill(process.env.SEED_ADMIN_PASSWORD ?? 'local-demo-passphrase');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Choose your conversation', exact: true }),
      ).toBeVisible();
      expect((await (await page.request.get('/api/v1/providers')).json()).simulation).toBe(true);
      await page.evaluate(() => localStorage.clear());
      await expect(page.locator('.workflow-card')).toHaveCount(5);
      await fits();
      await shot('workspace');
      for (const [id, label] of [
        ['sales', 'What are you offering?'],
        ['marketing', 'What is your campaign about?'],
        ['care', 'How should your agent help?'],
        ['appointments', 'What would you like to arrange?'],
      ]) {
        await page.goto(`/agents/${id}`);
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
        await fits();
      }
      await page.goto('/agents/hr');
      await page.getByLabel('Company name', { exact: true }).fill(`Synthetic Refresh ${width}`);
      await page.getByLabel('Job title', { exact: true }).fill('Frontend engineer');
      await page.getByLabel('Job location', { exact: true }).fill('Bengaluru');
      await page.getByLabel('Must-have requirements', { exact: true }).fill('2 years React');
      await page.getByLabel('Must-have requirements', { exact: true }).press('Enter');
      await page
        .getByLabel('Tell us about the role', { exact: true })
        .fill('Build accessible React applications.');
      await expect(page.locator('.question-option')).toHaveCount(5);
      await fits();
      await shot('recruitment-setup');
      await page.getByRole('button', { name: 'Continue to call', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Queue test call', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('Candidate name (optional)').fill('Synthetic');
      await page.getByLabel('Phone number', { exact: true }).fill('123');
      await page
        .getByRole('checkbox', {
          name: 'I confirm this person agreed to be called and I follow telemarketing rules.',
        })
        .check();
      await page.getByRole('button', { name: 'Queue test call', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Enter a valid phone number');
      await page.getByLabel('Phone number', { exact: true }).fill('+12025550125');
      await fits();
      await shot('phone-portal');
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
      await dialog.getByRole('button', { name: 'Close Browser test call', exact: true }).click();
      await expect(page.locator('.studio-results .lead-card')).toContainText('Saved internally');
      await expect(page.locator('.studio-results .match-panel')).toContainText('100%');
      await expect(page.locator('.studio-results details')).not.toHaveAttribute('open');
      await fits();
      await shot('recruitment-result');
      await page.getByRole('button', { name: 'Call another person', exact: true }).click();
      await page
        .getByRole('checkbox', {
          name: 'I confirm this person agreed to be called and I follow telemarketing rules.',
        })
        .check();
      const launch = page.waitForResponse(
        (r) => r.url().endsWith('/launch') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Queue test call', exact: true }).click();
      expect((await launch).ok()).toBe(true);
      await expect(
        page.getByRole('heading', { name: 'Every conversation has a next step.' }),
      ).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Settings', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Your voice. Your number. Your workspace.' }),
      ).toBeVisible();
      await page.locator('#connections').scrollIntoViewIfNeeded();
      await fits();
      await shot('connections');
      expect(errors).toEqual([]);
    } finally {
      if (ids.length) {
        const me = await (await page.request.get('/api/v1/auth/me')).json();
        for (const id of ids)
          await page.request.delete(`/api/v1/campaigns/${id}`, {
            headers: { 'X-CSRF-Token': me.csrf },
          });
      }
    }
  });
