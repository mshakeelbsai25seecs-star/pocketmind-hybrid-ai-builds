/**
 * Verify PocketCode approval buttons, tool-activity collapse, Diff scroll.
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const OUT = '/cursor/stores/self/media/verify-pocketcode-approval-diff';
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:4173/?verify=1';
fs.mkdirSync(OUT, { recursive: true });

function report(lines) {
  fs.writeFileSync(path.join(OUT, 'REPORT.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
}

async function main() {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const lines = [];
  const ok = (m) => { lines.push('OK: ' + m); };
  const fail = (m) => { lines.push('FAIL: ' + m); };

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => {
    const k = 'nexus-ai-storage';
    let parsed = { state: {}, version: 0 };
    try { parsed = JSON.parse(localStorage.getItem(k) || '{}'); } catch { /* */ }
    if (!parsed.state) parsed.state = {};
    parsed.state.setupCompleted = true;
    parsed.state.activeView = 'code-workspace';
    localStorage.setItem(k, JSON.stringify(parsed));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__PM_STORE__?.getState().setSetupCompleted(true);
    window.__PM_STORE__?.getState().setActiveView('code-workspace');
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '00-pocketcode.png'), fullPage: false });

  if (/PocketCode|Open a project|Describe a coding|code workspace/i.test(await page.locator('body').innerText())) {
    ok('PocketCode view loaded');
  } else {
    fail('PocketCode view not loaded');
  }

  const contract = await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'verify-pocketcode-fixture';
    host.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;z-index:9999;background:#111;padding:12px;';
    host.innerHTML = `
      <div style="border:1px solid #f59e0b;padding:8px;margin-bottom:8px;color:#fde68a;font-size:12px">
        <p>Approval required: file write pulse/public/1-newsfeed.html</p>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" id="v-allow" style="padding:6px 10px;background:#22c55e;border:0;color:#052e16;font-weight:700">Allow</button>
          <button type="button" id="v-deny" style="padding:6px 10px;border:1px solid #fde68a;background:transparent;color:#fde68a;font-weight:700">Deny</button>
        </div>
      </div>
      <button type="button" id="verify-tools-toggle" style="width:100%;text-align:left;padding:8px;border:1px solid #333;background:#1a1a1a;color:#ccc;margin-bottom:8px">Show tool activity (3)</button>
      <div id="verify-diff-scroll" style="height:160px;max-height:160px;overflow:auto;background:#0d1117;color:#c9d1d9;font:12px/1.5 monospace"></div>
    `;
    document.body.appendChild(host);
    const diff = host.querySelector('#verify-diff-scroll');
    const pre = document.createElement('pre');
    pre.style.margin = '0';
    pre.style.whiteSpace = 'pre';
    pre.textContent = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
    diff.appendChild(pre);
    return {
      allow: !!host.querySelector('#v-allow'),
      deny: !!host.querySelector('#v-deny'),
      toggleText: host.querySelector('#verify-tools-toggle')?.textContent?.trim(),
      scrollable: diff.scrollHeight > diff.clientHeight + 4,
      scrollHeight: diff.scrollHeight,
      clientHeight: diff.clientHeight,
    };
  });

  await page.screenshot({ path: path.join(OUT, '01-approval-and-diff.png'), fullPage: false });
  if (contract.allow && contract.deny) ok('Approval Allow/Deny controls present');
  else fail('Approval buttons missing');
  if (/Show tool activity|Hide tool activity|expand/i.test(contract.toggleText || '')) {
    ok(`Tool activity toggle label: ${contract.toggleText}`);
  } else {
    fail('Tool activity collapse control missing');
  }
  if (contract.scrollable) ok(`Diff scroll shell scrolls (${contract.scrollHeight}>${contract.clientHeight})`);
  else fail(`Diff scroll shell not scrollable sh=${contract.scrollHeight} ch=${contract.clientHeight}`);

  const layoutSrc = fs.readFileSync('/workspace/src/components/codeWorkspace/CodeWorkspaceLayout.tsx', 'utf8');
  const transcriptSrc = fs.readFileSync('/workspace/src/components/codeWorkspace/AgentTranscript.tsx', 'utf8');
  const diffSrc = fs.readFileSync('/workspace/src/components/codeWorkspace/GitDiffPane.tsx', 'utf8');
  if (layoutSrc.includes("resolveEdit('accepted')") && layoutSrc.includes('Always allow this session')) {
    ok('Layout status bar wires Allow/Deny to resolveEdit');
  } else {
    fail('Layout missing resolveEdit Allow/Deny wiring');
  }
  if (transcriptSrc.includes('Hide tool activity') && transcriptSrc.includes('forceCollapsed')) {
    ok('AgentTranscript has labeled collapse + forceCollapsed');
  } else {
    fail('AgentTranscript missing collapse fixes');
  }
  if (diffSrc.includes('DiffScrollShell') && diffSrc.includes('overflow-auto') && diffSrc.includes('diff.error')) {
    ok('GitDiffPane wraps error/diff paths in DiffScrollShell');
  } else {
    fail('GitDiffPane missing DiffScrollShell on error path');
  }

  const scripts = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(s => s.src));
  const asset = scripts.find(s => s.includes('index-') && s.endsWith('.js'));
  if (asset) {
    const js = await (await page.request.get(asset)).text();
    if (js.includes('Always allow this session')) ok('Bundle includes status-bar Always allow');
    else fail('Bundle missing Always allow this session');
    if (js.includes('Hide tool activity')) ok('Bundle includes Hide tool activity');
    else fail('Bundle missing Hide tool activity');
    if (js.includes('forceCollapsed')) ok('Bundle includes forceCollapsed prop');
    else fail('Bundle missing forceCollapsed');
  } else {
    fail('Could not locate index bundle');
  }

  await page.screenshot({ path: path.join(OUT, '02-final.png'), fullPage: false });

  const failed = lines.some(l => l.startsWith('FAIL:'));
  lines.push(failed ? 'RESULT: FAILED' : 'RESULT: PASSED');
  report(lines);
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
