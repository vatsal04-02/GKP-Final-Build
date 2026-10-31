// BROWSER test of the Payment Management page in the REAL FLOW HQ (built web app + real server process) against a throwaway Grist. Synthetic patients, made-up UTRs, a stand-in picture.
// Run:  REAL_GRIST_URL=http://127.0.0.1:18484 REAL_GRIST_KEY_FILE=<key file> npx tsx tests/e2e/payment-management.e2e.ts [screenshot dir]
// It signs in through the real login page, opens the new sidebar item, and drives the filters, the details drawer, an approval and a rejection through the UI.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PW, createStaging, deleteStaging, futureDay, slotId, startServer } from '../real-grist/harness';

const OUT = path.resolve(process.argv[2] || 'tests/e2e/screenshots'); fs.mkdirSync(OUT, { recursive: true });
let failed = 0; const ok = (c: unknown, m: string) => { if (!c) { failed++; console.log(`  FAIL ${m}`); } else console.log(`  ok   ${m}`); };
const s = await createStaging('staging-physio', { bookingOn: true });
const flow = await startServer(s, { env: { FLOWHQ_STATIC_DIR: path.resolve('dist/web') } });
const picture = fs.readFileSync(path.resolve('assets/kotak-upi-qr.jpg')).toString('base64');   // a stand-in picture: this is a SYNTHETIC test screenshot
try {
  const set = await flow.staff('admin', '/payments/settings', { method: 'PUT', body: { values: { consultation_fee_inr: '500', payee_authorization_note: 'Authorized by the clinic owner (e2e, synthetic)', payee_authorized: 'on', payments_enabled: 'on' } } }); ok(set.status === 200, 'admin opens payments (fee 500)');
  const DAY = futureDay(3);
  const mk = async (hh: string, name: string, phone: string, i: number) => { const r = await flow.api('/payments/requests', { method: 'POST', body: { slot_id: slotId('DR-001', DAY, hh), patient: { name, phone }, idempotency_key: `e2e-pay-key-${i}-abcdefgh`, channel: 'website' } }); if (r.status !== 201) throw new Error(`request ${r.status} ${r.text}`); return r.json.payment.payment_ref as string; };
  const shot = (ref: string, phone: string, utr?: string) => flow.api(`/payments/${ref}/screenshot`, { method: 'POST', body: { patient_phone: phone, data_base64: picture, source: 'website', ...(utr ? { utr } : {}) } });
  const good = (utr: string) => ({ amount: '500.00', utr, txn_time: new Date().toISOString(), payee: 'VATSAL TRIPATHI', payer: 'Synthetic Payer', status: 'SUCCESS', confidence: 0.94 });
  const a = await mk('09:00', 'Asha Test One', '9000070001', 1);                      // pending
  const b = await mk('09:30', 'Bela Test Two', '9000070002', 2); await shot(b, '9000070002', '411111111111'); await flow.api(`/payments/${b}/extraction`, { method: 'POST', body: { patient_phone: '9000070002', extraction: good('411111111111') } });   // review required, clean
  const c = await mk('10:00', 'Chitra Test Three', '9000070003', 3); await shot(c, '9000070003'); await flow.api(`/payments/${c}/extraction`, { method: 'POST', body: { patient_phone: '9000070003', extraction: { ...good('422222222222'), amount: '50.00', status: 'FAILED' } } });   // review required, flagged
  const d = await mk('10:30', 'Dev Test Four', '9000070004', 4); await shot(d, '9000070004');   // screenshot received (not yet read)
  const e = await mk('11:00', 'Esha Test Five', '9000070005', 5); await flow.api(`/appointments/${e}/cancel`, { method: 'POST', body: { patient_phone: '9000070005' } }); await fetch(`${flow.base}/api/health`);
  void a; void d; await new Promise((r) => setTimeout(r, 70000));   // the 60 s housekeeping closes the payment of the cancelled booking

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto(`${flow.base}/login`); await p.fill('input[type=email]', 'admin@test'); await p.fill('input[type=password]', PW); await p.click('button[type=submit]'); await p.waitForURL(/\/w\//);
  const W = `${flow.base}/w/${s.slug}`; await p.goto(W); await p.waitForTimeout(900);
  const nav = p.locator('nav a', { hasText: 'Payment Management' }); ok((await nav.count()) === 1, 'the sidebar has ONE "Payment Management" item'); await p.screenshot({ path: path.join(OUT, 'payment-management-1-sidebar.png') });
  const group = await nav.evaluate((el) => (el.closest('div,section,ul')?.parentElement?.textContent || '').slice(0, 80)); console.log('  sidebar context:', JSON.stringify(group));
  await nav.click(); await p.waitForURL(/\/payments$/); ok(/\/w\/staging-physio\/payments$/.test(p.url()), `route is ${new URL(p.url()).pathname}`);
  await p.waitForSelector('text=Payment Management'); await p.waitForSelector('tbody tr'); await p.waitForTimeout(400);
  const cards = await p.locator('button[aria-pressed]').allInnerTexts(); console.log('  cards:', JSON.stringify(cards.map((x) => x.replace(/\n/g, ' ')))); ok(cards.length === 5 && /Total collected/.test(cards[0]!) && /₹0/.test(cards[0]!), 'five overview cards; nothing collected yet (₹0)');
  ok(/Awaiting verification/.test(cards[1]!) && /^1/.test(cards[1]!) && /^2/.test(cards[2]!) && /Review required/.test(cards[2]!) && /^1/.test(cards[4]!), 'awaiting 1, review required 2, cancelled 1');
  const heads = await p.locator('thead th').allInnerTexts(); ok(['Booking reference', 'Patient', 'Contact', 'Appointment', 'Amount', 'Payment status', 'UTR', 'Submitted', 'Actions'].every((h, i) => heads[i] === h), 'table columns as specified');
  ok((await p.locator('tbody tr').count()) === 5, 'All shows five payments'); ok((await p.locator('tbody tr').first().innerText()).includes('₹500'), 'amount ₹500 shown');
  await p.screenshot({ path: path.join(OUT, 'payment-management-2-overview-table.png') });
  for (const [label, n] of [['Review required', 2], ['Screenshot received', 1], ['Pending', 1], ['Cancelled', 1], ['Paid', 0]] as Array<[string, number]>) { await p.locator('[role=tab]', { hasText: label }).first().click(); await p.waitForTimeout(450); ok((await p.locator('tbody tr').count()) === n, `filter "${label}" shows ${n}`); }
  await p.locator('[role=tab]', { hasText: 'Review required' }).first().click(); await p.waitForTimeout(450);
  await p.fill('input[aria-label="Search payments"]', '9000070003'); await p.waitForTimeout(700); ok((await p.locator('tbody tr').count()) === 1, 'search by contact number finds one payment'); await p.fill('input[aria-label="Search payments"]', ''); await p.waitForTimeout(600);
  await p.locator('tbody tr', { hasText: 'Chitra Test Three' }).click(); await p.waitForSelector('text=What the reader found'); await p.waitForTimeout(500);
  const dtext = await p.locator('body').innerText(); ok(/Amount on the screenshot is not the fee/.test(dtext) && /does not say the payment succeeded/.test(dtext), 'details show the automatic flags'); ok(await p.locator('img[alt^="Payment screenshot"]').isVisible(), 'screenshot preview is shown');
  ok(await p.locator('text=A screenshot is not proof of payment').count() > 0, 'the "screenshot is not proof" warning is shown'); await p.screenshot({ path: path.join(OUT, 'payment-management-3-details-flagged.png') });
  // approval needs the receipt tick + amount + UTR; a wrong amount is refused by the server
  const approveBtn = p.getByRole('button', { name: 'Mark paid and confirm appointment' }); ok(await approveBtn.isDisabled(), 'approve is disabled until amount, UTR and the receipt tick are given');
  await p.getByLabel('Amount received (₹)').fill('300'); await p.getByLabel('UTR from the bank statement (12 digits)').fill('422222222222'); await p.getByLabel(/I have seen this amount and UTR/).check(); await approveBtn.click(); await p.waitForSelector('text=is not the fee', { timeout: 8000 }).catch(() => undefined);
  ok(/not the fee/.test(await p.locator('body').innerText()), 'a different bank amount is refused with a clear message'); await p.locator('aside[role=dialog]').getByRole('button', { name: 'Close' }).click(); await p.waitForSelector('aside[role=dialog]', { state: 'detached' }); await p.waitForTimeout(300);
  // reject through the UI
  await p.locator('tbody tr', { hasText: 'Chitra Test Three' }).click(); await p.waitForSelector('text=What the reader found'); await p.getByRole('button', { name: 'Reject', exact: true }).click(); await p.getByLabel('Reason').fill('Amount is not on the bank statement'); await p.getByRole('button', { name: 'Reject' }).last().click(); await p.waitForTimeout(1200); if (await p.locator('aside[role=dialog]').count()) { await p.locator('aside[role=dialog]').getByRole('button', { name: 'Close' }).click(); await p.waitForSelector('aside[role=dialog]', { state: 'detached' }); }
  await p.locator('[role=tab]', { hasText: 'Rejected' }).first().click(); await p.waitForTimeout(600); ok((await p.locator('tbody tr', { hasText: 'Chitra Test Three' }).count()) === 1, 'rejected payment moves to the Rejected filter'); await p.screenshot({ path: path.join(OUT, 'payment-management-4-rejected.png') });
  // approve the clean one through the UI
  await p.locator('[role=tab]', { hasText: 'Review required' }).first().click(); await p.waitForTimeout(500); await p.locator('tbody tr', { hasText: 'Bela Test Two' }).click(); await p.waitForSelector('text=What the reader found'); await p.waitForTimeout(400);
  await p.getByLabel('Amount received (₹)').fill('500'); await p.getByLabel('UTR from the bank statement (12 digits)').fill('411111111111'); await p.getByLabel(/I have seen this amount and UTR/).check(); await p.screenshot({ path: path.join(OUT, 'payment-management-5-approve-form.png') }); await p.getByRole('button', { name: 'Mark paid and confirm appointment' }).click(); await p.waitForTimeout(1500);
  await p.locator('aside[role=dialog]').getByRole('button', { name: 'Close' }).click(); await p.waitForSelector('aside[role=dialog]', { state: 'detached' }); await p.waitForTimeout(500); await p.locator('[role=tab]', { hasText: 'Paid' }).first().click(); await p.waitForTimeout(700);
  ok((await p.locator('tbody tr', { hasText: 'Bela Test Two' }).count()) === 1, 'approved payment appears under Paid'); const cards2 = await p.locator('button[aria-pressed]').allInnerTexts(); ok(/₹500/.test(cards2[0]!), `Total collected now ${cards2[0]!.replace(/\n/g, ' ')}`); await p.screenshot({ path: path.join(OUT, 'payment-management-6-paid-total.png') });
  await p.locator('tbody tr', { hasText: 'Bela Test Two' }).click(); await p.waitForSelector('text=History'); await p.waitForTimeout(500); ok(/approved/.test(await p.locator('ol').last().innerText()) && /desk|admin@test/.test(await p.locator('ol').last().innerText()), 'history shows the approval with the staff identity'); await p.screenshot({ path: path.join(OUT, 'payment-management-7-history.png') });
  const sched = await p.goto(`${W}/schedule`); void sched; await p.waitForTimeout(900); ok((await p.locator('[role=tab]', { hasText: 'Payments' }).count()) === 0, 'the Schedule page no longer carries a second payments tab (no duplication)');
  // server-side truth
  const rows = await s.client.records(s.clinicDocId, 'Booking_Payments'); const byRef = (r: string) => rows.find((x) => x.fields.Booking_UID === r)!.fields;
  ok(byRef(b).Status === 'PAID' && byRef(b).Reviewed_By === 'admin@test' && byRef(b).Verification_Method === 'staff_bank_statement', 'database: approved by admin@test, method staff_bank_statement');
  ok(rows.filter((x) => x.fields.Status === 'PAID').length === 1, 'exactly one PAID (only the one a person verified)');
  const appts = await s.client.records(s.clinicDocId, 'Appointments'); ok(appts.find((x) => x.fields.Booking_UID === b)!.fields.Appt_Stage === 'Confirmed', 'its appointment is Confirmed');
  await browser.close();
} finally { await flow.stop('SIGKILL').catch(() => undefined); await deleteStaging(s).catch(() => undefined); }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0);
