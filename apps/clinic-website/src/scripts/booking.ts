/**
 * "Book your visit" — a *request* form. It validates the form, posts it to /api/enquiry (which hands it to the clinic's CRM)
 * and says "received", never "confirmed": the clinic contacts the visitor to confirm a slot. If sending fails, nothing is lost:
 * the form keeps what was typed and the same request can be sent on WhatsApp instead.
 */
import { openWhatsApp } from './whatsapp';
import { CONSENT_VERSION } from '../lib/enquiry-shared.mjs';

type Track = (name: string, params?: Record<string, string>) => void;
type Schedule = { timeZone: string; days: number[]; sessions: [string, string][] };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The next `count` open days in clinic time, as chip labels like "Mon 6". */
export function nextOpenDays(cfg: Schedule, now: Date, count = 6): { label: string; long: string }[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const minutes = n('hour') * 60 + n('minute');
  const closes = Math.max(...cfg.sessions.map(([, end]) => toMin(end)));
  // A calendar date in clinic time, held as UTC midnight so adding days never meets a DST shift
  const today = Date.UTC(n('year'), n('month') - 1, n('day'));
  const isOpenDay = (t: number) => cfg.days.includes(new Date(t).getUTCDay());

  // Today only counts while the clinic still has a session left; from a closed day (Sunday) start at the next open one
  let offset = isOpenDay(today) && minutes < closes ? 0 : 1;
  const days: { label: string; long: string }[] = [];
  const longFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  while (days.length < count && offset < 21) {
    const t = today + offset * 86_400_000;
    offset++;
    if (!isOpenDay(t)) continue;
    const d = new Date(t);
    days.push({ label: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`, long: longFmt.format(d) });
  }
  return days;
}

export function bookingMessage(v: { name: string; phone: string; concern: string; visit: string; day: string; slot: string }): string {
  return `Hello Geeta Krishna Physiotherapy, I found you through the website. I'd like to request an appointment — Name: ${v.name}, Phone: +91 ${v.phone}, Concern: ${v.concern}, Visit: ${v.visit}, Preferred: ${v.day}, ${v.slot}. Please confirm.`;
}

export function initBooking(track: Track): void {
  const form = document.querySelector<HTMLFormElement>('[data-book-form]');
  if (!form) return;
  const cfg = JSON.parse(form.dataset.schedule ?? 'null') as Schedule | null;
  const daysWrap = form.querySelector<HTMLElement>('[data-days]');
  const chipTpl = form.querySelector<HTMLTemplateElement>('template[data-day-chip]');
  const status = form.querySelector<HTMLElement>('[data-book-status]');
  const name = form.querySelector<HTMLInputElement>('#book-name')!;
  const phone = form.querySelector<HTMLInputElement>('#book-phone')!;
  const concern = form.querySelector<HTMLSelectElement>('#book-concern')!;
  if (!cfg || !daysWrap || !chipTpl) return;

  /* ---- Day chips (real upcoming dates, clinic time) ---- */
  let renderedFor = '';
  const renderDays = () => {
    const days = nextOpenDays(cfg, new Date());
    const key = days.map((d) => d.label).join('|');
    if (key === renderedFor) return;
    renderedFor = key;
    const chosen = form.querySelector<HTMLInputElement>('input[name="day"]:checked')?.value;
    daysWrap.replaceChildren(
      ...days.map((d) => {
        const chip = chipTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
        const input = chip.querySelector<HTMLInputElement>('input')!;
        input.value = d.label;
        input.checked = d.label === chosen;
        chip.querySelector('span')!.append(d.label);
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = ` (${d.long})`;
        chip.querySelector('span')!.append(sr);
        return chip;
      }),
    );
  };
  renderDays();
  document.addEventListener('visibilitychange', () => !document.hidden && renderDays()); // tab left open overnight

  /* ---- Phone: digits only (max 10), tolerant of a pasted "+91 98386 81421".
     Pasting is left alone (blocking it is bad for users and flagged by Lighthouse); whatever lands in the
     field is cleaned up straight afterwards, which is also why the input has no maxlength attribute. ---- */
  phone.addEventListener('input', () => {
    let digits = phone.value.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits !== phone.value) phone.value = digits;
  });

  /* ---- Validation with inline errors ---- */
  const checked = (field: string) => form.querySelector<HTMLInputElement>(`input[name="${field}"]:checked`)?.value ?? '';
  const rules: Record<string, { ok: () => boolean; control: () => HTMLElement | null; err: string }> = {
    name: { ok: () => name.value.trim().length > 0, control: () => name, err: 'book-name-err' },
    phone: { ok: () => /^\d{10}$/.test(phone.value), control: () => phone, err: 'book-phone-err' },
    concern: { ok: () => concern.value !== '', control: () => concern, err: 'book-concern-err' },
    day: { ok: () => checked('day') !== '', control: () => form.querySelector('input[name="day"]'), err: 'book-day-err' },
    slot: { ok: () => checked('slot') !== '', control: () => form.querySelector('input[name="slot"]'), err: 'book-slot-err' },
  };
  const show = (key: string, bad: boolean) => {
    const rule = rules[key];
    const err = document.getElementById(rule.err);
    if (err) err.hidden = !bad;
    const control = rule.control();
    if (control && (key === 'name' || key === 'phone' || key === 'concern')) {
      if (bad) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }
  };
  let attempted = false;
  const recheck = (key: string) => attempted && show(key, !rules[key].ok());
  name.addEventListener('input', () => recheck('name'));
  phone.addEventListener('input', () => recheck('phone'));
  concern.addEventListener('change', () => recheck('concern'));
  form.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === 'day' || target.name === 'slot') recheck(target.name);
  });

  /* ---- Sending ---- */
  const endpoint = form.dataset.endpoint || '/api/enquiry';
  const submitBtn = form.querySelector<HTMLButtonElement>('[data-book-submit]');
  const label = form.querySelector<HTMLElement>('[data-book-label]');
  const fallback = form.querySelector<HTMLElement>('[data-book-fallback]');
  const waBtn = form.querySelector<HTMLButtonElement>('[data-book-wa]');
  const consent = form.querySelector<HTMLInputElement>('#book-consent');
  const honeypot = form.querySelector<HTMLInputElement>('#book-website');
  const CLIENT_TIMEOUT_MS = 12_000;
  let submitting = false;
  let lastSig = '';
  let lastId = '';

  const say = (text: string, failed = false) => {
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    status.dataset.state = failed ? 'error' : 'ok';
  };
  const busy = (on: boolean) => {
    submitting = on;
    if (submitBtn) {
      submitBtn.disabled = on;
      submitBtn.setAttribute('aria-busy', String(on));
    }
    if (label) label.textContent = on ? 'Sending…' : 'Send request';
  };
  const currentMessage = () =>
    bookingMessage({ name: name.value.trim().replace(/\s+/g, ' '), phone: phone.value, concern: concern.value, visit: checked('visit'), day: checked('day'), slot: checked('slot') });
  waBtn?.addEventListener('click', () => {
    track('whatsapp_click', { location: 'booking-form-fallback' });
    openWhatsApp(`https://wa.me/${form.dataset.wa}?text=${encodeURIComponent(currentMessage())}`);
  });

  const MESSAGES: Record<string, string> = {
    timeout: "We couldn't confirm that your request arrived (the connection timed out). Please send it on WhatsApp or call the clinic. If it did arrive, the clinic will see it only once.",
    consent_required: "The clinic's system could not record this request without your WhatsApp permission. Tick the WhatsApp box, or send your request on WhatsApp or by phone.",
    rate_limited: 'Too many attempts. Please wait a minute, or send your request on WhatsApp or call the clinic.',
    invalid: 'Please check the highlighted details and try again.',
    unavailable: "We couldn't send your request right now. Your details are still here: please try again, or send it on WhatsApp or call the clinic.",
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return; // a double click or a second Enter press while one request is in flight
    attempted = true;
    if (status) status.hidden = true;
    if (fallback) fallback.hidden = true;
    let firstBad: HTMLElement | null = null;
    for (const key of Object.keys(rules)) {
      const bad = !rules[key].ok();
      show(key, bad);
      if (bad && !firstBad) firstBad = rules[key].control();
    }
    if (firstBad) {
      firstBad.focus();
      return;
    }

    const fields = {
      name: name.value.trim().replace(/\s+/g, ' '),
      phone: `+91${phone.value}`,
      concern: concern.value,
      visit: checked('visit'),
      day: checked('day'),
      slot: checked('slot'),
      consent_whatsapp: !!consent?.checked,
    };
    // The same details keep the same request id, so a retry (or a double send) is recognised by the server as one request.
    const sig = JSON.stringify(fields);
    if (sig !== lastSig) {
      lastSig = sig;
      lastId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const body = {
      ...fields,
      website: honeypot?.value ?? '',
      request_id: lastId,
      consent_version: CONSENT_VERSION,
      page_url: location.origin + location.pathname,
      utm_campaign: new URLSearchParams(location.search).get('utm_campaign') ?? '',
    };

    busy(true);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    let outcome = 'unavailable';
    let fieldErrors: Record<string, string> = {};
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; fields?: Record<string, string> } | null;
      if (res.ok && data?.ok === true) outcome = 'received';
      else if (data?.error && data.error in MESSAGES) {
        outcome = data.error;
        fieldErrors = data.fields ?? {};
      } else if (res.status === 504) outcome = 'timeout';
    } catch (err) {
      outcome = err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : 'unavailable';
    } finally {
      clearTimeout(timer);
      busy(false);
    }

    track('enquiry_result', { result: outcome === 'received' ? 'received' : 'failed' });
    if (outcome === 'received') {
      say('Thank you. The clinic has received your request and will contact you to confirm your slot. Your visit is not confirmed yet.');
      form.reset();
      renderedFor = '';
      renderDays();
      attempted = false;
      for (const key of Object.keys(rules)) show(key, false);
      return;
    }
    for (const key of Object.keys(rules)) if (fieldErrors[key]) show(key, true);
    say(MESSAGES[outcome] ?? MESSAGES.unavailable, true);
    if (fallback) fallback.hidden = false;
  });
}
