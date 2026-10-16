// FLOW HQ end-to-end run in demo mode: starts the built server with demo data, drives a real browser through every page and
// the key flows, and saves screenshots to tests/e2e/screenshots. Run `npm run build` first. Exit code 1 on the first failure.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots');
const PORT = Number(process.env.E2E_PORT || 8799);
const BASE = `http://localhost:${PORT}`;
const PAGES = ['', 'inbox', 'contacts', 'bookings', 'automations', 'tasks', 'reports', 'activity', 'ai', 'settings'];
const ADMIN = { email: 'admin@flowhq.demo', password: 'demo1234' };
const STAFF = { email: 'staff@flowhq.demo', password: 'demo1234' };

if (!existsSync(path.join(ROOT, 'dist/server/index.js')) || !existsSync(path.join(ROOT, 'dist/web/index.html'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const results = [];
let server;
let browser;
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name} (${Date.now() - t} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`  FAIL  ${name}\n        ${String(e.message || e).split('\n')[0]}`); throw e; }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function startServer() {
  server = spawn(process.execPath, ['dist/server/index.js'], { cwd: ROOT, env: { ...process.env, FLOWHQ_DEMO: 'true', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

// console errors and server errors fail the run; web fonts are optional (offline machines cannot reach them)
function watch(page, bag) {
  page.on('pageerror', (e) => bag.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) bag.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) bag.push(`HTTP ${r.status()} ${r.url()}`); });
}
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 10000 });
  await page.waitForTimeout(350);   // let number animations finish before a screenshot
  const err = await page.locator('[role=alert]:has-text("Could not load this")').count();
  expect(err === 0, `an error panel is shown on ${page.url()}`);
}
async function login(page, who) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/w\/[^/]+/, { timeout: 10000 });
}
const navText = (page) => page.locator('nav[aria-label=Main]').first().innerText();

async function main() {
  console.log('FLOW HQ e2e (demo data)');
  await startServer();
  browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  watch(page, errors);

  await step('login page renders and rejects a wrong password', async () => {
    await page.goto(`${BASE}/login`);
    await page.screenshot({ path: path.join(SHOTS, '00-login.png') });
    await page.fill('#email', ADMIN.email); await page.fill('#password', 'wrong-password'); await page.click('button[type=submit]');
    await page.getByText('Email or password is not correct').waitFor({ timeout: 5000 });
  });
  await step('admin signs in and lands on a workspace dashboard', async () => {
    await login(page, ADMIN);
    await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor();
    await settle(page);
  });
  const wsId = new URL(page.url()).pathname.split('/')[2];

  for (const [i, p] of PAGES.entries()) {
    await step(`page /${p || 'dashboard'} loads without errors`, async () => {
      await page.goto(`${BASE}/w/${wsId}${p ? `/${p}` : ''}`);
      await settle(page);
      await page.screenshot({ path: path.join(SHOTS, `${String(i + 1).padStart(2, '0')}-${p || 'dashboard'}.png`), fullPage: p !== 'inbox' });
    });
  }
  await step('settings sections all render', async () => {
    for (const s of ['branding', 'terminology', 'team', 'channels', 'ai', 'automations', 'notifications', 'business_hours', 'integrations']) {
      await page.goto(`${BASE}/w/${wsId}/settings/${s}`);
      await settle(page);
      if (s === 'terminology' || s === 'integrations') await page.screenshot({ path: path.join(SHOTS, `11-settings-${s}.png`), fullPage: true });
    }
  });

  await step('staff reply goes through the backend path: queued, then sent (or held in quiet hours)', async () => {
    const list = await page.evaluate(async (w) => (await fetch(`/api/w/${w}/conversations`)).json(), wsId);
    const c = list.find((x) => x.replyWindow.open && !x.optedOut);
    expect(c, 'no conversation with an open reply window in the demo data');
    await page.goto(`${BASE}/w/${wsId}/inbox/${c.id}`);
    await settle(page);
    const text = `E2E reply ${Date.now()}`;
    await page.fill('textarea[aria-label=Reply]', text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const bubble = page.locator(`text=${text}`);
    await bubble.waitFor();
    await page.getByText(/queued: goes out within a minute|sending/).first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, '20-inbox-reply-queued.png') });
    // the demo plays W10 with W10's own rules: in the day the reply is sent; 21:00-08:00 IST it is held for quiet hours
    await page.waitForFunction(() => !document.body.innerText.match(/queued: goes out within a minute|sending/), null, { timeout: 20000 });
    const thread = await page.evaluate(async ([w, id]) => (await fetch(`/api/w/${w}/conversations/${id}`)).json(), [wsId, c.id]);
    const m = thread.messages.find((x) => x.body === text);
    const held = m && m.status === 'pending' && /quiet hours/.test(m.statusNote || '');
    expect(m && m.author.kind === 'staff' && (m.status === 'sent' || held), `reply status is ${m && m.status} (${m && m.statusNote})`);
    if (held) await page.getByText(/waiting: quiet hours/).first().waitFor();
    console.log(`        (${held ? 'held by the quiet-hours rule, shown in the thread' : 'sent'})`);
    await page.screenshot({ path: path.join(SHOTS, held ? '21-inbox-reply-held-quiet-hours.png' : '21-inbox-reply-sent.png') });
  });

  await step('switching workspace changes the words, not the design', async () => {
    await page.goto(`${BASE}/w/${wsId}`);
    await settle(page);
    const before = await navText(page);
    await page.locator('button[aria-haspopup=listbox]').click();
    await page.getByRole('option', { name: /Studio Lumi/ }).click();
    await page.waitForURL(/\/w\/demo-salon/);
    await settle(page);
    const after = await navText(page);
    expect(/Patients/.test(before) && /Clients/.test(after) && !/Patients/.test(after), `nav before: ${before.replace(/\n/g, ' ')} | after: ${after.replace(/\n/g, ' ')}`);
    const body = await page.locator('main').innerText();
    expect(!/patient|physio|clinic/i.test(body), 'salon dashboard shows words from another industry');
    await page.screenshot({ path: path.join(SHOTS, '30-salon-dashboard.png') });
  });
  await step('renaming a word in Settings > Terminology updates every page', async () => {
    await page.goto(`${BASE}/w/demo-salon/settings/terminology`);
    await settle(page);
    const fs = page.locator('fieldset').first();
    await fs.locator('input').nth(0).fill('Guest');
    await fs.locator('input').nth(1).fill('Guests');
    await page.getByRole('button', { name: 'Save words' }).click();
    await page.waitForFunction(() => document.querySelector('nav[aria-label=Main]')?.textContent?.includes('Guests'), null, { timeout: 5000 });
    await page.goto(`${BASE}/w/demo-salon/contacts`);
    await settle(page);
    await page.getByRole('heading', { name: 'Guests' }).waitFor();
    await page.goto(`${BASE}/w/demo-salon/settings/terminology`);
    await settle(page);
    await page.getByRole('button', { name: 'Reset to the industry words' }).click();
    await page.waitForFunction(() => document.querySelector('nav[aria-label=Main]')?.textContent?.includes('Clients'), null, { timeout: 5000 });
  });
  await step('changing the industry swaps terminology and keeps the layout', async () => {
    await page.goto(`${BASE}/w/demo-realty/settings/workspace`);
    await settle(page);
    const before = await navText(page);
    const industry = page.locator('select').filter({ has: page.locator('option[value=agency]') });
    await industry.selectOption('agency');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('nav[aria-label=Main]')?.textContent?.includes('Prospects'), null, { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, '31-realty-as-agency-settings.png'), fullPage: true });
    await industry.selectOption('real_estate');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.waitForFunction((b) => document.querySelector('nav[aria-label=Main]')?.textContent?.includes('Leads') && b.includes('Leads'), before, { timeout: 5000 });
    await page.goto(`${BASE}/w/demo-realty`);
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, '32-realty-dashboard.png') });
  });
  await step('command palette (Ctrl+K) and g-shortcuts navigate', async () => {
    await page.goto(`${BASE}/w/${wsId}`);
    await settle(page);
    await page.keyboard.press('Control+k');
    await page.locator('[role=dialog] input[aria-label=Search]').fill('automations');
    await page.screenshot({ path: path.join(SHOTS, '40-command-palette.png') });
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/automations$/);
    await page.locator('body').click({ position: { x: 5, y: 400 } }).catch(() => {});
    await page.keyboard.press('g'); await page.keyboard.press('i');
    await page.waitForURL(/\/inbox/);
  });
  await step('both themes render (light is the clinic default) and the toggle flips them', async () => {
    await page.goto(`${BASE}/w/${wsId}`);
    await settle(page);
    const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const toggle = () => page.getByRole('button', { name: /Switch to (light|dark) mode/ });
    const first = await theme();
    expect(first === 'light', `the clinic default theme should be light, got ${first}`);
    await page.screenshot({ path: path.join(SHOTS, '41-dashboard-light.png') });
    await toggle().click();
    await page.waitForTimeout(300);
    expect((await theme()) === 'dark', 'the toggle did not switch to dark');
    await page.screenshot({ path: path.join(SHOTS, '41-dashboard-dark.png') });
    await page.goto(`${BASE}/w/${wsId}/inbox`);
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, '42-inbox-dark.png') });
    await toggle().click();
    await page.waitForTimeout(200);
    expect((await theme()) === 'light', 'the toggle did not switch back to light');
  });
  await step('API responses carry no backend ids or keys', async () => {
    const bodies = await page.evaluate(async (w) => Promise.all(['/api/me', `/api/w/${w}/workspace`, `/api/w/${w}/settings`, `/api/w/${w}/automations`, `/api/w/${w}/conversations`].map(async (u) => (await fetch(u)).text())), wsId);
    const all = bodies.join('\n');
    expect(!/DEMO_PHYSIO|DEMO_SALON|DEMO_REALTY|Grist_Doc_ID|WA_Phone_Number_ID|10000000000000\d/.test(all), 'a backend document id or phone-number id reached the browser');
  });
  expect(!errors.length, `browser errors:\n${errors.join('\n')}`);

  await step('staff sees settings and automation switches read-only', async () => {
    const staff = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const sp = await staff.newPage();
    const se = []; watch(sp, se);
    await login(sp, STAFF);
    await sp.goto(`${BASE}/w/${wsId}/settings/business_hours`);
    await settle(sp);
    expect(await sp.getByRole('button', { name: 'Save changes' }).count() === 0, 'staff can see a Save button');
    await sp.goto(`${BASE}/w/${wsId}/automations`);
    await settle(sp);
    const switches = sp.locator('button[role=switch]');
    const n = await switches.count();
    for (let i = 0; i < n; i++) expect(await switches.nth(i).isDisabled(), 'an automation switch is enabled for staff');
    const r = await sp.evaluate(async (w) => (await fetch(`/api/w/${w}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ values: { open_time: '07:00' } }) })).status, wsId);
    expect(r === 403, `staff PATCH settings returned ${r}`);
    await sp.screenshot({ path: path.join(SHOTS, '50-staff-automations.png') });
    expect(!se.length, se.join('\n'));
    await staff.close();
  });
  await step('phone width: no sideways scroll, menu opens', async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
    const mp = await m.newPage();
    await login(mp, ADMIN);
    for (const p of ['', 'inbox', 'contacts', 'automations', 'settings']) {
      await mp.goto(`${BASE}/w/${wsId}${p ? `/${p}` : ''}`);
      await settle(mp);
      const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over <= 1, `/${p} scrolls sideways by ${over}px`);
      if (p === '' || p === 'inbox') await mp.screenshot({ path: path.join(SHOTS, `60-mobile-${p || 'dashboard'}.png`) });
    }
    for (const name of ['Sign out', /Switch to (light|dark) mode/, 'Open menu']) {   // the theme button's label depends on the current theme
      const box = await mp.getByRole('button', { name }).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 390, `top-bar button "${String(name)}" is off-screen`);
    }
    await mp.getByRole('button', { name: 'Open menu' }).click();
    await mp.locator('nav[aria-label=Main]').last().waitFor();
    await mp.screenshot({ path: path.join(SHOTS, '61-mobile-menu.png') });
    await m.close();
  });
}

main()
  .then(() => { console.log(`\n${results.filter((r) => r.ok).length}/${results.length} e2e steps passed. Screenshots: tests/e2e/screenshots`); })
  .catch(() => { console.log(`\nE2E FAILED (${results.filter((r) => r.ok).length}/${results.length} steps passed)`); process.exitCode = 1; })
  .finally(async () => { await browser?.close().catch(() => {}); server?.kill(); });
