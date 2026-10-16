// Browser test of the booking form in real Chromium against the BUILT site (dist/), with the real api/enquiry.mjs and a fake n8n.
// Optional: needs Playwright, which is not a dependency of this site. Run:  npm run build && node tests/e2e/booking-browser.mjs
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  (default: `playwright`)   CHROMIUM=/path/to/chrome (optional)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHandler } from '../../api/enquiry.mjs';

const pw = await import(process.env.PLAYWRIGHT_MODULE ? `${process.env.PLAYWRIGHT_MODULE}/index.mjs` : 'playwright').then((m) => m.default ?? m);
const DIST = path.resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain', '.xml': 'application/xml' };

// ---- fake n8n: what it answers is set per scenario; every payload it receives is kept
let ipCounter = 0;
let n8nMode = 'ok';
const n8nSeen = [];
const fakeFetch = async (_url, init) => {
  n8nSeen.push(JSON.parse(init.body));
  if (n8nMode === 'down') return { status: 500, json: async () => ({}) };
  if (n8nMode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (n8nMode === 'consent') return { status: 400, json: async () => ({ status: 'invalid', error: 'consent required' }) };
  if (n8nMode === 'slow') await new Promise((r) => setTimeout(r, 600));
  return { status: 200, json: async () => ({ status: 'ok', action: 'created' }) };
};
const handler = createHandler({ env: { N8N_WEBHOOK_URL: 'https://n8n.example.test/webhook-test/website-lead', N8N_WEBHOOK_SECRET: 'synthetic-test-secret-0123456789', CLINIC_SLUG: 'test-clinic' }, fetchImpl: fakeFetch });

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/enquiry') {
    const chunks = []; for await (const c of req) chunks.push(c);
    req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    res.setHeader = res.setHeader.bind(res); res.end = res.end.bind(res);
    req.headers['x-forwarded-for'] = `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}`;   // each request from its own address: the per-address rate limit is covered in tests/enquiry-api.test.mjs
    return handler(req, res);
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] ?? 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--no-sandbox'] });
let passed = 0;
const results = [];
const test = async (name, fn, viewport = { width: 1280, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.route(/wa\.me|google|gstatic|fonts/, (r) => r.fulfill({ status: 200, body: '' }));   // nothing leaves the machine
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/enquiry')) posts.push(r.postDataJSON()); });
  n8nSeen.length = 0; n8nMode = 'ok';
  await page.goto(`${base}/#book`);
  try { await fn(page, posts, ctx); passed++; results.push(`  ok  ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); process.exitCode = 1; await page.screenshot({ path: `/tmp/e2e-fail-${passed}.png` }).catch(() => {}); }
  await ctx.close();
};
const fill = async (page, { name = 'Test Patient', phone = '98765 43210', consent = false } = {}) => {
  await page.fill('#book-name', name);
  await page.fill('#book-phone', phone);
  await page.selectOption('#book-concern', 'Back Pain');
  await page.locator('input[name="day"]').first().check({ force: true });
  await page.locator('input[name="slot"]').first().check({ force: true });
  if (consent) await page.locator('#book-consent').check();
};
const status = (page) => page.locator('[data-book-status]');

await test('valid request: one POST, "received" (not "confirmed"), form cleared, no WhatsApp tab opened', async (page, posts, ctx) => {
  const popups = []; ctx.on('page', (p) => popups.push(p.url()));
  await fill(page);
  await page.click('[data-book-submit]');
  await status(page).waitFor({ state: 'visible' });
  const text = await status(page).innerText();
  assert.match(text, /received your request/i); assert.match(text, /not confirmed yet/i);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].name, posts[0].phone, posts[0].concern, posts[0].consent_whatsapp], ['Test Patient', '+9198765 43210'.replace(' ', ''), 'Back Pain', false]);
  assert.equal(n8nSeen.length, 1);
  assert.equal(await page.inputValue('#book-name'), '');
  assert.equal(popups.length, 0);
});

await test('double click while sending: exactly one request and one n8n call; the button is disabled meanwhile', async (page, posts) => {
  n8nMode = 'slow';
  await fill(page);
  await page.dblclick('[data-book-submit]');
  assert.equal(await page.locator('[data-book-submit]').isDisabled(), true);
  await status(page).waitFor({ state: 'visible' });
  assert.equal(posts.length, 1); assert.equal(n8nSeen.length, 1);
});

await test('invalid phone: inline error, no request', async (page, posts) => {
  await fill(page, { phone: '12345' });
  await page.click('[data-book-submit]');
  await page.locator('#book-phone-err').waitFor({ state: 'visible' });
  assert.equal(posts.length, 0);
});

await test('missing name: inline error, no request', async (page, posts) => {
  await fill(page, { name: '' });
  await page.click('[data-book-submit]');
  await page.locator('#book-name-err').waitFor({ state: 'visible' });
  assert.equal(posts.length, 0);
});

await test('CRM down: honest failure message, details kept, WhatsApp fallback opens with the request text, retry reuses the request id', async (page, posts, ctx) => {
  n8nMode = 'down';
  await fill(page);
  await page.click('[data-book-submit]');
  await status(page).waitFor({ state: 'visible' });
  assert.match(await status(page).innerText(), /couldn't send your request/i);
  assert.doesNotMatch(await status(page).innerText(), /received your request/i);
  assert.equal(await page.inputValue('#book-name'), 'Test Patient');
  assert.equal(await page.locator('[data-book-fallback]').isVisible(), true);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-book-wa]')]);
  assert.match(popup.url(), /^https:\/\/wa\.me\/\d+\?text=/);
  assert.match(decodeURIComponent(popup.url()), /Test Patient/);
  n8nMode = 'ok';
  await page.click('[data-book-submit]');
  await page.waitForFunction(() => /received your request/i.test(document.querySelector('[data-book-status]').textContent));
  assert.equal(posts.length, 2); assert.equal(posts[0].request_id, posts[1].request_id);
});

await test('timeout: the visitor is told it may not have arrived and is offered WhatsApp', async (page) => {
  n8nMode = 'timeout';
  await fill(page);
  await page.click('[data-book-submit]');
  await status(page).waitFor({ state: 'visible' });
  assert.match(await status(page).innerText(), /couldn't confirm that your request arrived/i);
  assert.equal(await page.locator('[data-book-fallback]').isVisible(), true);
});

await test('consent is separate: unticked sends consent_whatsapp=false and still succeeds; ticked sends true', async (page, posts) => {
  await fill(page, { consent: false });
  await page.click('[data-book-submit]');
  await page.waitForFunction(() => /received your request/i.test(document.querySelector('[data-book-status]').textContent));
  await fill(page, { phone: '98765 43211', consent: true });
  await page.click('[data-book-submit]');
  await page.waitForTimeout(300);
  assert.deepEqual(posts.map((p) => p.consent_whatsapp), [false, true]);
});

await test('the CRM insists on consent: the visitor is told to tick the box or use WhatsApp / phone', async (page) => {
  n8nMode = 'consent';
  await fill(page);
  await page.click('[data-book-submit]');
  await status(page).waitFor({ state: 'visible' });
  assert.match(await status(page).innerText(), /WhatsApp permission/i);
  assert.equal(await page.locator('[data-book-fallback]').isVisible(), true);
});

await test('refresh after a successful request: an empty form and no new request', async (page, posts) => {
  await fill(page);
  await page.click('[data-book-submit]');
  await page.waitForFunction(() => /received your request/i.test(document.querySelector('[data-book-status]').textContent));
  await page.reload();
  assert.equal(await page.inputValue('#book-name'), '');
  assert.equal(await page.locator('[data-book-status]').isHidden(), true);
  assert.equal(posts.length, 1);
});

await test('honeypot field is invisible to people and empty on a normal submit', async (page, posts) => {
  const box = await page.locator('#book-website').boundingBox();   // off-screen (not display:none, which some bots skip) and hidden from assistive tech
  assert(!box || box.x + box.width <= 0, 'the honeypot sits outside the page');
  assert.equal(await page.locator('.hp').getAttribute('aria-hidden'), 'true');
  await fill(page); await page.click('[data-book-submit]');
  await status(page).waitFor({ state: 'visible' });
  assert.equal(posts[0].website, '');
});

await test('phone width (390 px): no sideways scroll, form usable', async (page) => {
  await page.locator('#book').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('[data-book-form]').screenshot({ path: process.env.SHOT || '/tmp/e2e-form-390.png' });
}, { width: 390, height: 844 });

await browser.close(); server.close();
console.log(results.join('\n')); console.log(`browser: ${passed}/${results.length} passed`);
