/**
 * Playwright SOC UI walkthrough (Vite + browser store).
 * Screenshots → /cursor/stores/self/media/soc-walkthrough/
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/cursor/stores/self/media/soc-walkthrough';
const BASE = process.env.SOC_WALK_URL || 'http://127.0.0.1:5173';
fs.mkdirSync(OUT, { recursive: true });

const storage = {
  state: {
    setupCompleted: true,
    activeView: 'soc',
    theme: 'light',
    sidebarOpen: true,
  },
  version: 0,
};

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('shot', file);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', err => console.warn('pageerror', err.message));

  await context.addInitScript(data => {
    localStorage.setItem('nexus-ai-storage', JSON.stringify(data));
    localStorage.removeItem('pocketmind-soc-incidents-v1');
    localStorage.removeItem('pocketmind-soc-cases-v1');
    localStorage.removeItem('pocketmind-soc-memory-v1');
  }, storage);

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);

  // Force SOC view if store hydrate raced
  await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('nexus-ai-storage');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, setupCompleted: true, activeView: 'soc' };
      localStorage.setItem('nexus-ai-storage', JSON.stringify(parsed));
    } catch { /* ignore */ }
  });
  // Click SOC in sidebar if visible
  const socBtn = page.getByRole('button', { name: /^SOC$/ }).first();
  if (await socBtn.count()) await socBtn.click().catch(() => undefined);
  await page.waitForTimeout(800);
  await shot(page, '01-queue-empty');

  // New case
  const newCase = page.getByRole('button', { name: /New case/i });
  if (await newCase.count()) {
    await newCase.click();
    await page.waitForTimeout(800);
    await shot(page, '02-case-blank');
    await page.getByPlaceholder('Summary').fill('VPN failures then success from unusual geo');
    await page.getByPlaceholder('Source IP').fill('203.0.113.50');
    await page.getByPlaceholder('User').fill('j.saeed');
    await page.getByPlaceholder('Raw evidence / logs').fill('2026-09-27T01:00Z fail\n2026-09-27T01:09Z success');
    await page.waitForTimeout(600);
    await shot(page, '03-case-filled');
    // Manual evidence note
    await page.getByPlaceholder('Add analyst evidence note').fill('Checked AD — user is finance.');
    await page.getByRole('button', { name: /Append note/i }).click();
    await page.waitForTimeout(500);
    await shot(page, '04-evidence-note');
  }

  // Import via paste
  await page.getByRole('button', { name: /^Import$/ }).click();
  await page.waitForTimeout(500);
  const paste = page.getByPlaceholder(/paste FortiSIEM/i);
  await paste.fill(JSON.stringify([{
    incidentId: '9001',
    incidentTitle: 'Brute force VPN',
    eventSeverityCat: 'High',
    srcIpAddr: '198.51.100.9',
    user: 'a.user',
    incidentDetail: 'Many failures',
  }], null, 2));
  await page.getByRole('button', { name: /Parse paste/i }).click();
  await page.waitForTimeout(600);
  await shot(page, '05-import-preview');
  await page.getByRole('button', { name: /Import into queue/i }).click();
  await page.waitForTimeout(800);
  await shot(page, '06-queue-after-import');

  // Memory
  await page.getByRole('button', { name: /^Memory$/ }).click();
  await page.waitForTimeout(400);
  await page.locator('textarea').first().fill('Known contractor VPN pool');
  // fill key - second text-ish input after selects
  const inputs = page.locator('input.input-field');
  const count = await inputs.count();
  if (count >= 2) await inputs.nth(0).fill('203.0.113.50');
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForTimeout(500);
  await shot(page, '07-memory');

  // Metrics
  await page.getByRole('button', { name: /^Metrics$/ }).click();
  await page.waitForTimeout(600);
  await shot(page, '08-metrics');

  // Connectors
  await page.getByRole('button', { name: /^Connectors$/ }).click();
  await page.waitForTimeout(500);
  await shot(page, '09-connectors');

  // Knowledge / Workspace / Validators / Reports / Practice
  for (const [name, file] of [
    ['Knowledge', '10-knowledge'],
    ['Workspace', '11-workspace'],
    ['Validators', '12-validators'],
    ['Reports', '13-reports'],
    ['Practice', '14-practice'],
  ]) {
    await page.getByRole('button', { name: new RegExp(`^${name}$`) }).click();
    await page.waitForTimeout(700);
    await shot(page, file);
  }

  await browser.close();
  console.log('soc-walkthrough done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
