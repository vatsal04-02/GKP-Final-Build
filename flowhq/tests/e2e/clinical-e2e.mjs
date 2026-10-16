// Clinical records, end to end in a real browser (Chromium via Playwright), against a FLOWHQ_DEMO=true server (in-memory data, nothing real).
//   npm run build && FLOWHQ_DEMO=true PORT=8787 node dist/server/index.js      (in one terminal)
//   npm run test:e2e:clinical                                                  (in another; BASE_URL and OUT_DIR are optional)
// Writes screenshots and the two printed PDFs to OUT_DIR. Run it against a fresh server: it registers GK-P-000001.
import { chromium } from 'playwright';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const B = process.env.BASE_URL || 'http://localhost:8787';
const WS = process.env.E2E_WS || 'demo-physio'; const EMAIL = process.env.E2E_EMAIL || 'staff@flowhq.demo'; const PASSWORD = process.env.E2E_PASSWORD || 'demo1234';   // defaults = the FLOWHQ_DEMO users; set these to run against a real-Grist FlowHQ
const S = process.env.OUT_DIR || path.join(os.tmpdir(), 'gk-e2e'); fs.mkdirSync(S, { recursive: true });
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
// a synthetic 240x160 PNG (no real patient data)
function png(w, h) {
  const crc = (b) => { let c; const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const b = Buffer.concat([Buffer.from(ty), d]); const o = Buffer.alloc(4); o.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([o, b, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = (x * 255 / w) | 0; raw[i + 1] = (y * 255 / h) | 0; raw[i + 2] = 120; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && !/status of 409/.test(m.text()) && errs.push(m.text()));   // 409 = the duplicate warning, by design
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(false, `${name} — ${String(e).split('\n')[0]}`); await p.screenshot({ path: `${S}/fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {}); } };

await p.goto(`${B}/login`); await p.fill('input[type=email]', EMAIL); await p.fill('input[type=password]', PASSWORD); await p.click('button[type=submit]');
await p.waitForURL(/\/w\//); const W = `${B}/w/${WS}`; await p.goto(W); await p.waitForTimeout(800);
const nav = await p.locator('nav[aria-label=Main]').innerText();
ok(['Patients', 'Prescriptions', 'Invoices & Payments', 'Attendance', 'Enquiries'].every((x) => nav.includes(x)), `nav shows the clinical pages and "Enquiries": ${nav.replace(/\n+/g, ' | ')}`);

await step('register', async () => {
  await p.goto(`${W}/patients`); await p.waitForSelector('text=No patients found'); await p.screenshot({ path: `${S}/ui-register-empty.png` });
  await p.click('button:has-text("Add patient") >> nth=0'); const f = p.locator('form');
  await f.getByLabel('Patient name').fill('Test Patient One'); await f.getByLabel('Mobile number').fill('98765 43210'); await f.getByLabel('Age', { exact: true }).fill('34'); await f.getByLabel('Sex').selectOption('Female');
  await f.getByLabel('Address').fill('12 Test Road, Gomti Nagar, Lucknow'); await f.getByLabel('Referred by (doctor)').fill('Dr Referrer'); await f.getByLabel('Occupation').fill('Teacher'); await f.getByLabel('Disorder / main complaint').fill('Right knee pain on climbing stairs');
  await p.click('button:has-text("Register patient")'); await p.waitForURL(/patients\/GK-P-000001/); ok(true, 'patient registered; profile opened at /patients/GK-P-000001');
  await p.goto(`${W}/patients`); await p.click('button:has-text("Add patient") >> nth=0'); await p.locator('form').getByLabel('Patient name').fill('Another Name'); await p.locator('form').getByLabel('Mobile number').fill('+91 98765 43210');
  await p.click('button:has-text("Register patient")'); await p.waitForSelector('text=may be a patient who is already registered'); ok(true, 'duplicate phone is warned about, not merged'); await p.click('button:has-text("Cancel")');
  await p.reload(); await p.waitForSelector('text=Test Patient One'); ok((await p.locator('tbody tr').count()) === 1, 'after a full page refresh the patient is still in the register');
  await p.fill('input[aria-label="Search patients"]', '98765'); await p.waitForTimeout(600); ok((await p.locator('tbody tr').count()) === 1, 'search by phone digits finds the patient');
  await p.fill('input[aria-label="Search patients"]', 'zzzz'); await p.waitForSelector('text=No patients found'); await p.fill('input[aria-label="Search patients"]', ''); await p.waitForSelector('text=Test Patient One');
});

await step('prescription', async () => {
  await p.goto(`${W}/prescriptions/new?patient=GK-P-000001`); await p.waitForSelector('text=Patient ID:');
  await p.getByLabel('Treating physiotherapist').fill('Dr. Sandeep Tiwari'); await p.getByLabel('Blood pressure').fill('120/80');
  await p.getByLabel('Clinical history').fill('Pain for 3 weeks.\nWorse on stairs.'); await p.getByLabel('O/E: clinical examination findings').fill('Mild swelling. ROM reduced.');
  await p.getByLabel('Diagnosis', { exact: true }).fill('Test diagnosis entered by clinician'); await p.getByLabel('Physiotherapy treatment').fill('Ultrasound, quadriceps strengthening'); await p.getByLabel('Advice', { exact: true }).fill('Avoid stairs for a week.');
  await p.setInputFiles('input[type=file]', { name: 'knee.png', mimeType: 'image/png', buffer: png(240, 160) });
  await p.waitForSelector('text=Not saved yet'); const pv = await p.$eval('img[alt="Photo preview"]', (i) => new Promise((r) => (i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));  ok(pv > 0, `photo preview actually renders (width ${pv}) and is labelled "Not saved yet"`);
  await p.setInputFiles('input[type=file]', { name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') }); await p.waitForSelector('text=could not be read'); ok(true, 'a non-image file is refused with a message');
  ok(await p.getByRole('button', { name: 'Print Prescription' }).isDisabled(), 'Print is disabled until the prescription is saved');
  await p.click('button:has-text("Save prescription")'); await p.waitForURL(/prescriptions\/RX-000001/); await p.waitForSelector('img[alt="Saved clinical photograph"]');
  ok(true, 'prescription saved; photo is now shown from the server (not a browser preview)');
  await p.reload(); await p.waitForSelector('img[alt="Saved clinical photograph"]');
  const w = await p.$eval('img[alt="Saved clinical photograph"]', (i) => new Promise((r) => (i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));
  ok(w === 240, `after refresh the saved photo loads from the server (width ${w})`);
  ok((await p.getByLabel('Diagnosis', { exact: true }).inputValue()) === 'Test diagnosis entered by clinician', 'the prescription reopens with what was typed');
  await p.screenshot({ path: `${S}/ui-rx-editor.png`, fullPage: true });
  await p.getByLabel('Advice', { exact: true }).fill('Avoid stairs for two weeks.'); await p.click('button:has-text("Save changes")'); await p.waitForSelector('text=Version 2');
  ok((await p.locator('img[alt="Saved clinical photograph"]').count()) === 1, 'edit saved as version 2; photo still attached');
});

await step('print-rx', async () => {
  const pp = await ctx.newPage(); await pp.goto(`${W}/print/prescription/RX-000001`); await pp.waitForSelector('article[aria-label=Prescription]'); await pp.waitForSelector('button:has-text("Print"):not([disabled])');
  await pp.emulateMedia({ media: 'print' });
  const h = await pp.evaluate(() => ({ nav: !!document.querySelector('nav'), aside: !!document.querySelector('aside'), btn: [...document.querySelectorAll('.no-print')].every((e) => getComputedStyle(e).display === 'none') }));
  ok(!h.nav && !h.aside && h.btn, 'print view has no navigation, sidebar or buttons');
  await pp.pdf({ path: `${S}/prescription.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
  const pages = fs.readFileSync(`${S}/prescription.pdf`).toString('latin1').match(/\/Type\s*\/Page[^s]/g).length; ok(pages === 1, `prescription with one photo prints on ${pages} A4 page(s)`);
  await pp.emulateMedia({ media: 'screen' }); await pp.screenshot({ path: `${S}/ui-rx-print.png`, fullPage: true });
});

await step('invoice', async () => {
  await p.goto(`${W}/invoices/new?patient=GK-P-000001`); await p.waitForSelector('text=GK-P-000001');
  await p.getByLabel('Service description').first().fill('Physiotherapy session'); await p.getByLabel('Quantity or sessions').first().fill('5'); await p.getByLabel('Unit price in rupees').first().fill('600');
  await p.click('button:has-text("Add another service")'); await p.getByLabel('Service description').nth(1).fill('Ultrasound therapy'); await p.getByLabel('Unit price in rupees').nth(1).fill('150.50'); await p.getByLabel('Discount (₹)').fill('100');
  const t = await p.locator('dt:text-is("Total")').locator('xpath=../dd').innerText(); ok(t === '₹3,050.50', `live total preview = ${t} (5×600 + 150.50 − 100)`);
  ok((await p.locator('text=No tax is configured').count()) === 1, 'no tax is offered because none is configured');
  await p.getByLabel('Amount (₹)').fill('1000'); await p.screenshot({ path: `${S}/ui-invoice-editor.png`, fullPage: true });
  await p.getByRole('button', { name: 'Save invoice' }).dblclick();   // double click on purpose
  await p.waitForURL(/invoices\/GK-\d{4}-000001/); await p.waitForSelector('text=Part paid');
  await p.goto(`${W}/invoices`); await p.waitForSelector('tbody tr'); ok((await p.locator('tbody tr').count()) === 1, 'a double click on Save made exactly one invoice');
  await p.click('tbody tr'); await p.waitForSelector('button:has-text("Record payment")'); await p.click('button:has-text("Record payment")');
  const d = p.getByRole('dialog'); await d.getByLabel('Amount received (₹)').fill('99999'); await d.getByRole('button', { name: 'Record payment' }).click(); await p.waitForSelector('text=balance due is only'); ok(true, 'overpayment is refused');
  await d.getByLabel('Amount received (₹)').fill('2050.50'); await d.getByRole('button', { name: 'Record payment' }).click(); await p.waitForSelector('text=Payment recorded');
  await p.waitForFunction(() => document.body.innerText.includes('Balance due') && document.body.innerText.includes('₹0.00'));
  const bal = await p.locator('dt:text-is("Balance due")').locator('xpath=../dd').innerText(); ok(bal === '₹0.00', `final payment clears the balance (${bal})`);
  await p.screenshot({ path: `${S}/ui-invoice-detail.png`, fullPage: true });
});

await step('register-totals', async () => {
  await p.goto(`${W}/patients`); await p.waitForSelector('text=Test Patient One');
  const r = (await p.locator('tbody tr').first().innerText()).replace(/\s+/g, ' '); ok(r.includes('₹3,050.50') && r.includes('₹0.00') && /\d\d\/\d\d\/\d{4}/.test(r), `register row shows billed / paid / balance: ${r.slice(0, 200)}`);
  await p.screenshot({ path: `${S}/ui-register.png` });
  await p.click('tbody tr'); await p.waitForSelector('text=Patient record'); await p.getByRole('tab', { name: /Invoices & payments/ }).click(); await p.waitForSelector('text=Payment history');
  ok((await p.locator('text=/Cash/').count()) >= 2, 'patient record lists both payments in the payment history'); await p.screenshot({ path: `${S}/ui-profile-billing.png` });
});

await step('print-invoice', async () => {
  const ip = await ctx.newPage(); const yr = new Date().getFullYear(); await ip.goto(`${W}/print/invoice/GK-${yr}-000001`); await ip.waitForSelector('article[aria-label=Invoice]');
  const txt = await ip.locator('article').innerText(); ok(txt.includes('Three Thousand Fifty Rupees and Fifty Paise Only'), 'printed invoice carries the amount in words'); ok(txt.includes('Authorised Signatory'), 'printed invoice has a signature area');
  await ip.emulateMedia({ media: 'print' }); await ip.pdf({ path: `${S}/invoice.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true }); await ip.emulateMedia({ media: 'screen' }); await ip.screenshot({ path: `${S}/ui-invoice-print.png`, fullPage: true });
});

await step('attendance', async () => {
  await p.goto(`${W}/attendance`); await p.waitForSelector('text=Test Patient One');
  const cells = p.locator('tbody button:not([disabled])'); const n = await cells.count(); const last = cells.nth(n - 1); await last.click(); await p.waitForTimeout(900);
  ok((await last.innerText()).includes('✓'), 'clicking a day marks attendance, saved by the server'); await p.screenshot({ path: `${S}/ui-attendance.png` });
  await p.goto(`${W}/patients`); await p.getByRole('button', { name: 'Weekly attendance' }).click(); await p.waitForTimeout(600); await p.screenshot({ path: `${S}/ui-register-week.png` });
});

for (const path of ['', '/contacts', '/inbox', '/bookings', '/automations', '/reports', '/settings']) { await p.goto(`${W}${path}`); await p.waitForTimeout(600); }
ok(errs.length === 0, `no browser console / page errors while using every page${errs.length ? ': ' + errs.slice(0, 3).join(' || ') : ''}`);
await b.close();
