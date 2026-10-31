// Click-to-chat links: number formats and the ready-made messages.
import { describe, expect, it } from 'vitest';
import { followUpMessage, reviewMessage, waLink, waNumber } from '../src/web/clinical/whatsapp';

describe('waNumber', () => {
  it('turns every common Indian format into digits with the country code', () => {
    for (const p of ['+919876543210', '+91 98765 43210', '98765 43210', '9876543210', '09876543210', '91-98765-43210']) expect(waNumber(p)).toBe('919876543210');
  });
  it('refuses numbers that cannot be right', () => {
    for (const p of ['', '12345', 'abc', '+91 98765']) expect(waNumber(p)).toBeNull();
  });
});

describe('waLink', () => {
  it('opens wa.me with the message encoded', () => {
    const url = waLink('+91 98765 43210', 'Hello Asha, see you & thanks?')!;
    expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1]!)).toBe('Hello Asha, see you & thanks?');
  });
  it('gives no link without a usable number', () => { expect(waLink('', 'hi')).toBeNull(); });
});

describe('messages', () => {
  const base = { name: 'Rahul Kumar', clinic: 'Geeta Krishna Physiotherapy Centre', today: '2026-10-25' };
  it('follow-up: greets by first name, names the clinic and says how late it is', () => {
    expect(followUpMessage({ ...base, followUpOn: '2026-10-14' })).toMatch(/^Hello Rahul, this is Geeta Krishna Physiotherapy Centre\..*was due a few days ago/);
    expect(followUpMessage({ ...base, followUpOn: '2026-10-25' })).toMatch(/is due today/);
    expect(followUpMessage({ ...base, followUpOn: '2026-10-26' })).toMatch(/is due tomorrow/);
    expect(followUpMessage({ ...base, followUpOn: '2026-10-27' })).toMatch(/coming up soon/);
  });
  it('review: says how long since the last visit, or invites a first session', () => {
    expect(reviewMessage({ name: 'Asha', clinic: 'C', days: 12, never: false })).toMatch(/12 days since your last visit/);
    expect(reviewMessage({ name: 'Asha', clinic: 'C', days: 12, never: true })).toMatch(/first session/);
  });
  it('still reads well when the clinic name is not loaded yet', () => {
    expect(followUpMessage({ name: '', clinic: '', followUpOn: '2026-10-25', today: '2026-10-25' })).toMatch(/^Hello there, this is the clinic\./);
  });
});
