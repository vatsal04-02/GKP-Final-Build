// BROWSER test of the prescription condition suggestions in the REAL built FLOW HQ web app, served by the real server process in DEMO mode (in-memory data, fictional people). Synthetic text.
//   npm run build && npx tsx tests/e2e/rx-suggestions.e2e.ts [screenshot dir]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const OUT = path.resolve(process.argv[2] || 'tests/e2e/screenshots'); fs.mkdirSync(OUT, { recursive: true });
let failed = 0; const ok = (c: unknown, m: string) => { if (!c) { failed++; console.log(`  FAIL ${m}`); } else console.log(`  ok   ${m}`); };
const port = await new Promise<number>((res) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = (sv.address() as net.AddressInfo).port; sv.close(() => res(p)); }); });
const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: String(port), FLOWHQ_DEMO: 'true', FLOWHQ_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef-xyz', FLOWHQ_SECURE_COOKIES: 'false', FLOWHQ_STATIC_DIR: path.resolve('dist/web'), FLOWHQ_CLINIC_FILE: path.resolve('config/clinic.json'), NODE_ENV: 'test' }, stdio: 'ignore' });
const flow = { base: `http://127.0.0.1:${port}`, stop: async () => { proc.kill('SIGKILL'); } };
const s = { slug: 'demo-physio' };
for (let i = 0; i < 100; i++) { try { if ((await fetch(flow.base + '/api/health')).status < 500) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 200)); }
try {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const p = await ctx.newPage();
  await p.goto(`${flow.base}/login`); await p.fill('input[type=email]', 'admin@flowhq.demo'); await p.fill('input[type=password]', 'demo1234'); await p.click('button[type=submit]'); await p.waitForURL(/\/w\//);
  const W = `${flow.base}/w/${s.slug}`;
  const call = (pth: string, method: string, body: unknown) => p.evaluate(async ([u, m, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; }, [`/api/w/${s.slug}${pth}`, method, body]);
  const pat = await call('/patients', 'POST', { name: 'Synthetic Rx Patient', phone: '9000081111', mainComplaint: 'shoulder' }); ok(pat.s === 201, 'synthetic patient created');
  const rx = (diagnosis: string, treatmentPlan: string, advice: string, rxDate: string) => call('/prescriptions', 'POST', { patientId: pat.j.patientId, rxDate, treatingPhysio: 'Dr. Sandeep Tiwari', bp: '', vitals: '', history: '', examination: '', diagnosis, treatmentPlan, exercises: '', advice, followUpOn: null });
  await rx('Frozen shoulder', 'OLD: heat, mobilisation', 'old advice', '2026-09-01'); await rx('Frozen shoulder', 'Pendulum exercises and gentle mobilisation (synthetic test text)', 'Avoid heavy lifting (synthetic)', '2026-10-05'); await rx('Low back pain', 'Core stability (synthetic)', '', '2026-10-06');
  await p.goto(`${W}/prescriptions/new`); await p.waitForSelector('text=Treated at this clinic'); await p.waitForTimeout(400);
  const learned = await p.locator('[aria-label="Condition suggestions"] button').allInnerTexts(); console.log('  chips:', JSON.stringify(learned.slice(0, 6)));
  ok(/^Frozen shoulder · 2×/.test(learned[0] || '') && learned.some((x) => /^Low back pain · 1×/.test(x)) && learned.some((x) => /^Plantar fasciitis/.test(x)), 'the clinic\'s own conditions (including the demo clinic\'s existing prescriptions) come first, most used first, with counts');
  ok(learned.some((x) => x === 'Sciatica'), 'common conditions are offered too (names only)'); await p.screenshot({ path: path.join(OUT, 'rx-suggestions-1-chips.png') });
  await p.getByRole('button', { name: /^Frozen shoulder · 2×/ }).click(); await p.waitForTimeout(500);
  ok((await p.getByLabel('Diagnosis').inputValue()) === 'Frozen shoulder', 'the diagnosis is filled');
  ok((await p.getByLabel(/Physiotherapy treatment/).inputValue()).startsWith('Pendulum exercises'), 'the EMPTY treatment box is filled from the latest prescription for that condition (not the older one)');
  ok((await p.getByLabel('Advice').inputValue()) === 'Avoid heavy lifting (synthetic)', 'the empty advice box is filled'); ok(/Please review and edit/.test(await p.locator('body').innerText()), 'the doctor is told to review and edit');
  await p.screenshot({ path: path.join(OUT, 'rx-suggestions-2-filled.png') });
  // text already written is never overwritten
  await p.goto(`${W}/prescriptions/new`); await p.waitForSelector('text=Treated at this clinic'); await p.getByLabel(/Physiotherapy treatment/).fill('MY OWN PLAN'); await p.getByRole('button', { name: /^Low back pain · 1×/ }).click(); await p.waitForTimeout(400);
  ok((await p.getByLabel(/Physiotherapy treatment/).inputValue()) === 'MY OWN PLAN' && (await p.getByLabel('Diagnosis').inputValue()) === 'Low back pain', 'a written treatment is never overwritten; the diagnosis is still set');
  // typing filters the suggestions
  await p.getByLabel('Diagnosis').fill('knee'); await p.waitForTimeout(300); const filtered = await p.locator('[aria-label="Condition suggestions"] button').allInnerTexts(); ok(filtered.length > 0 && filtered.every((x) => /knee/i.test(x)), `typing "knee" narrows the chips (${filtered.length})`);
  await browser.close();
} finally { await flow.stop(); }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0);
