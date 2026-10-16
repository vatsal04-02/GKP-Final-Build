import { describe, expect, it } from 'vitest';
import { amountInWords, computeTotals, formatRupees, paymentStatus, parseRupees } from '@core/money';

describe('rupees <-> paise', () => {
  it.each([['5000', 500000], ['5,000.50', 500050], ['₹ 12.5', 1250], ['0', 0], ['0.07', 7], ['99999999.99', 9999999999]])('parses %s', (s, p) => expect(parseRupees(s)).toBe(p));
  it.each(['', '-5', '1.234', 'abc', '1e3', '1,00,0000000', '5000.', '.5'])('rejects %s', (s) => expect(parseRupees(s)).toBeNull());
  it('formats with Indian grouping and 2 decimals', () => { expect(formatRupees(500000)).toBe('₹5,000.00'); expect(formatRupees(12345678)).toBe('₹1,23,456.78'); expect(formatRupees(5)).toBe('₹0.05'); });
});
describe('invoice totals (integer paise, no float drift)', () => {
  it('sums lines, applies discount, no tax by default', () => {
    const t = computeTotals([{ description: 'Session', qty: 5, unitPaise: 60000 }, { description: 'Ultrasound', qty: 1, unitPaise: 15050 }], 20000);
    expect(t).toMatchObject({ subtotalPaise: 315050, discountPaise: 20000, taxPaise: 0, totalPaise: 295050 });
  });
  it('taxes the discounted amount and rounds half up', () => {
    expect(computeTotals([{ description: 'x', qty: 1, unitPaise: 10050 }], 0, 1800).taxPaise).toBe(1809);   // 180.9
    expect(computeTotals([{ description: 'x', qty: 1, unitPaise: 1025 }], 0, 500).taxPaise).toBe(51);       // 51.25 -> 51
    expect(computeTotals([{ description: 'x', qty: 1, unitPaise: 1030 }], 0, 500).taxPaise).toBe(52);       // 51.5 -> 52
    expect(computeTotals([{ description: 'x', qty: 2, unitPaise: 50000 }], 20000, 1800)).toMatchObject({ taxPaise: 14400, totalPaise: 94400 });
  });
  it('0.1 + 0.2 style sums stay exact', () => expect(computeTotals([{ description: 'a', qty: 3, unitPaise: 10 }], 0).subtotalPaise).toBe(30));
});
describe('amount in words (Indian grouping)', () => {
  it.each([[500000, 'Five Thousand Rupees Only'], [100, 'One Rupee Only'], [0, 'Zero Rupees Only'], [12345678, 'One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy Eight Paise Only'],
    [125000000, 'Twelve Lakh Fifty Thousand Rupees Only'], [10000000000, 'Ten Crore Rupees Only'], [1000000000, 'One Crore Rupees Only'], [150, 'One Rupee and Fifty Paise Only'], [1000000, 'Ten Thousand Rupees Only']])('%i', (p, w) => expect(amountInWords(p)).toBe(w));
  it('refuses nonsense instead of printing a wrong sentence', () => { expect(amountInWords(-1)).toBeNull(); expect(amountInWords(1.5)).toBeNull(); expect(amountInWords(1e15)).toBeNull(); });
});
describe('payment status', () => {
  it('derives from total and paid', () => {
    expect(paymentStatus('issued', 1000, 0)).toBe('unpaid'); expect(paymentStatus('issued', 1000, 400)).toBe('partial');
    expect(paymentStatus('issued', 1000, 1000)).toBe('paid'); expect(paymentStatus('void', 1000, 0)).toBe('void');
  });
});
