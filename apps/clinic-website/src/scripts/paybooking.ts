/**
 * "Book and pay online" (src/components/PayBooking.astro). Talks only to /api/pay. The section stays hidden unless the server says payments are open.
 * It never claims a booking is confirmed until the server says so ("confirmed" is set only after the clinic has checked the money).
 */
type Schedule = { timeZone: string; days: number[]; sessions: [string, string][] };
type Slot = { slot_id: string; start_time: string; end_time: string; doctor_name: string; shift: string };
type Pay = { payment_ref: string; status: string; message: string; amount_inr: string; expires_at: string | null; can_upload: boolean; appointment: { date: string; start_time: string; doctor_name: string | null } | null };
const KEY = 'gkp-pay-booking';
const TERMINAL = ['confirmed', 'expired', 'refunded', 'cancelled'];
const TONE: Record<string, 'ok' | 'warn' | 'bad'> = { confirmed: 'ok', received: 'warn', under_review: 'warn', awaiting_payment: 'warn', not_verified: 'bad', expired: 'bad', refunded: 'warn', cancelled: 'bad' };

const post = async (body: Record<string, unknown>) => {
  try {
    const r = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json: any = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  } catch { return { status: 0, json: null }; }
};
const ERR: Record<string, string> = { slot_unavailable: 'That time was just taken. Please choose another time.', payments_closed: 'Online payment is not available right now. Please use the request form above.', booking_closed: 'Online booking is not available right now. Please use the request form above.', invalid_phone: 'Please enter a valid 10-digit mobile number.', invalid_name: 'Please enter your name.', duplicate: 'You already have this time reserved.', unavailable: 'Something went wrong. Please try again in a minute, or use the request form above.', rate_limited: 'Too many tries. Please wait a minute.', expired: 'The payment time has run out. Please book again.', invalid_image: 'Please send a PNG, JPEG or WebP picture.', too_large: 'That picture is too large.', too_many: 'Too many screenshots for this booking. Please call the clinic.', not_found: 'We could not find that booking.', not_accepting: 'This booking can no longer take a screenshot.' };

/** The next open days as ISO dates in clinic time (the clinic's own calendar, never the visitor's). */
export function openDates(cfg: Schedule, now: Date, count = 7): Array<{ iso: string; label: string }> {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const today = Date.UTC(n('year'), n('month') - 1, n('day')); const out: Array<{ iso: string; label: string }> = [];
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  for (let i = 0; out.length < count && i < 21; i++) { const t = today + i * 86_400_000; const d = new Date(t); if (!cfg.days.includes(d.getUTCDay())) continue; out.push({ iso: d.toISOString().slice(0, 10), label: fmt.format(d) }); }
  return out;
}

/** A phone screenshot is often 5 MB+: shrink it in the browser (the server accepts up to ~4 MB). */
async function prepareImage(file: File): Promise<{ base64: string; mime: string } | { error: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return { error: 'invalid_image' };
  const toB64 = (blob: Blob) => new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(new Error('read')); fr.readAsDataURL(blob); });
  if (file.size <= 2_500_000) return { base64: await toB64(file), mime: file.type };
  try {
    const bmp = await createImageBitmap(file); const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale)); c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); if (!blob || blob.size > 3_000_000) return { error: 'too_large' };
    return { base64: await toB64(blob), mime: 'image/jpeg' };
  } catch { return { error: 'invalid_image' }; }
}

export async function initPayBooking(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-pay]'); if (!root) return;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let cfg: Schedule | null = null; try { cfg = JSON.parse(root.dataset.schedule || 'null'); } catch { cfg = null; }
  if (!cfg) return;
  let open: { fee_inr: string; payee_name: string } | null = null;
  try { const r = await fetch('/api/pay?action=config', { cache: 'no-store' }); const j = await r.json(); if (j?.payments?.open === true && j.payments.fee_inr) open = { fee_inr: String(j.payments.fee_inr), payee_name: String(j.payments.payee_name || '') }; } catch { /* stays hidden */ }
  if (!open) return;   // payments are not open: the page is exactly as it was
  root.hidden = false;
  root.querySelectorAll('[data-pay-fee],[data-pay-fee2]').forEach((e) => { e.textContent = open!.fee_inr; });

  const days = q<HTMLElement>('[data-pay-days]'); const slotsBox = q<HTMLElement>('[data-pay-slots]'); const who = q<HTMLElement>('[data-pay-who]');
  const name = q<HTMLInputElement>('[data-pay-name]'); const phone = q<HTMLInputElement>('[data-pay-phone]'); const chosenEl = q<HTMLElement>('[data-pay-chosen]'); const err = q<HTMLElement>('[data-pay-err]');
  const reserve = q<HTMLButtonElement>('[data-pay-reserve]'); const stepPick = q<HTMLElement>('[data-pay-step="pick"]'); const stepPay = q<HTMLElement>('[data-pay-step="pay"]');
  let date = ''; let slot: Slot | null = null; let rid = ''; let timer: number | undefined;
  const showErr = (el: HTMLElement, code: string) => { el.textContent = ERR[code] || ERR.unavailable!; el.hidden = false; };
  const digits = () => phone.value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

  for (const d of openDates(cfg, new Date())) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = d.label; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', async () => {
      days.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', 'false')); b.setAttribute('aria-checked', 'true'); date = d.iso; slot = null; who.hidden = true; err.hidden = true;
      slotsBox.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Loading free times…' }));
      const r = await post({ action: 'slots', date: d.iso });
      if (r.status !== 200 || !r.json?.ok) { slotsBox.replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: ERR.unavailable })); return; }
      const list: Slot[] = r.json.slots || [];
      if (!r.json.booking_open || !list.length) { slotsBox.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: r.json.closed ? 'The clinic is closed on that day.' : 'No free times that day. Please try another day.' })); return; }
      const nodes: HTMLElement[] = []; let last = '';
      for (const s of list) {
        if (s.doctor_name !== last) { last = s.doctor_name; nodes.push(Object.assign(document.createElement('div'), { className: 'grp', textContent: `${s.doctor_name} · ${s.shift === 'evening' ? 'Evening' : 'Morning'}` })); }
        const sb = document.createElement('button'); sb.type = 'button'; sb.textContent = s.start_time; sb.setAttribute('role', 'radio'); sb.setAttribute('aria-checked', 'false');
        sb.addEventListener('click', () => { slotsBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', 'false')); sb.setAttribute('aria-checked', 'true'); slot = s; who.hidden = false; chosenEl.textContent = `${d.label}, ${s.start_time} with ${s.doctor_name}`; });
        nodes.push(sb);
      }
      slotsBox.replaceChildren(...nodes);
    });
    days.append(b);
  }

  const render = (p: Pay, phoneDigits: string) => {
    stepPick.hidden = true; stepPay.hidden = false;
    const ap = p.appointment; q('[data-pay-ref]').textContent = p.payment_ref;
    q('[data-pay-summary]').textContent = ap ? `${ap.date} at ${ap.start_time}${ap.doctor_name ? ` with ${ap.doctor_name}` : ''}. Fee ₹${p.amount_inr}.` : `Fee ₹${p.amount_inr}.`;
    const st = q<HTMLElement>('[data-pay-status]'); st.textContent = p.message + (p.status === 'awaiting_payment' && p.expires_at ? ` Pay before ${new Date(p.expires_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.` : ''); st.dataset.tone = TONE[p.status] || 'warn';
    const showPay = p.status === 'awaiting_payment' || p.status === 'not_verified';
    q('[data-pay-howto]').hidden = !showPay; q('[data-pay-upload]').hidden = !p.can_upload;
    q('[data-pay-payee]').textContent = open!.payee_name ? `Pay to: ${open!.payee_name}` : '';
    if (showPay && !q<HTMLImageElement>('[data-pay-qr]').src) void post({ action: 'qr', payment_ref: p.payment_ref, patient_phone: phoneDigits }).then((r) => { if (r.json?.ok) q<HTMLImageElement>('[data-pay-qr]').src = `data:${r.json.mime};base64,${r.json.data_base64}`; });
    window.clearTimeout(timer);
    if (!TERMINAL.includes(p.status)) timer = window.setTimeout(() => void refresh(p.payment_ref, phoneDigits), 8000);
  };
  const refresh = async (ref: string, ph: string) => { const r = await post({ action: 'status', payment_ref: ref, patient_phone: ph }); if (r.status === 200 && r.json?.ok) render(r.json as Pay, ph); else if (r.status === 404) { try { sessionStorage.removeItem(KEY); } catch { /* */ } } else timer = window.setTimeout(() => void refresh(ref, ph), 15000); };

  reserve.addEventListener('click', async () => {
    err.hidden = true; if (!slot) return showErr(err, 'slot_unavailable');
    if (name.value.trim().length < 2) return showErr(err, 'invalid_name'); if (!/^[6-9]\d{9}$/.test(digits())) return showErr(err, 'invalid_phone');
    rid ||= `web-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('')}`; reserve.disabled = true;
    const r = await post({ action: 'book', slot_id: slot.slot_id, patient_name: name.value.trim(), patient_phone: `+91${digits()}`, request_id: rid });
    reserve.disabled = false;
    if (r.status === 201 || (r.status === 200 && r.json?.ok)) { try { sessionStorage.setItem(KEY, JSON.stringify({ ref: r.json.payment_ref, ph: `+91${digits()}` })); } catch { /* */ } render(r.json as Pay, `+91${digits()}`); return; }
    if (r.json?.error === 'slot_unavailable') rid = '';   // the next try is a new request
    showErr(err, r.json?.error || 'unavailable');
  });
  q<HTMLButtonElement>('[data-pay-send]').addEventListener('click', async () => {
    const uerr = q<HTMLElement>('[data-pay-uerr]'); uerr.hidden = true; const file = q<HTMLInputElement>('[data-pay-file]').files?.[0];
    let saved: { ref: string; ph: string } | null = null; try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { /* */ } if (!saved) return showErr(uerr, 'not_found');
    if (!file) return showErr(uerr, 'invalid_image');
    const btn = q<HTMLButtonElement>('[data-pay-send]'); btn.disabled = true;
    const img = await prepareImage(file); if ('error' in img) { btn.disabled = false; return showErr(uerr, img.error); }
    const r = await post({ action: 'screenshot', payment_ref: saved.ref, patient_phone: saved.ph, data_base64: img.base64, mime: img.mime, utr: q<HTMLInputElement>('[data-pay-utr]').value.replace(/\D/g, '') });
    btn.disabled = false;
    if (r.status === 200 && r.json?.ok) { q<HTMLInputElement>('[data-pay-file]').value = ''; render(r.json as Pay, saved.ph); } else showErr(uerr, r.json?.error || 'unavailable');
  });
  q<HTMLButtonElement>('[data-pay-reset]').addEventListener('click', () => { try { sessionStorage.removeItem(KEY); } catch { /* */ } window.clearTimeout(timer); stepPay.hidden = true; stepPick.hidden = false; rid = ''; q<HTMLImageElement>('[data-pay-qr]').removeAttribute('src'); });

  try { const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (saved?.ref && saved?.ph) void refresh(saved.ref, saved.ph); } catch { /* nothing saved */ }
}
