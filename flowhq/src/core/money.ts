// INR money as integer paise. One implementation for the server (which decides) and the browser (which previews).
export const MAX_PAISE = 99_99_99_999_99;           // below 100 crore: far beyond a clinic invoice, keeps integers exact

// "1,250.50" / "1250" / "₹ 1250.5" -> paise. null when it is not a plain non-negative amount with at most 2 decimals.
export function parseRupees(input: string | number): number | null {
  const s = String(input).replace(/[₹,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ''] = s.split('.');
  const paise = Number(r) * 100 + Number(p.padEnd(2, '0'));
  return paise <= MAX_PAISE ? paise : null;
}
export function formatRupees(paise: number, locale = 'en-IN'): string {
  const neg = paise < 0; const a = Math.abs(Math.round(paise));
  const whole = Math.floor(a / 100); const frac = a % 100;
  return `${neg ? '-' : ''}₹${whole.toLocaleString(locale)}.${String(frac).padStart(2, '0')}`;
}

export interface LineInput { description: string; qty: number; unitPaise: number }
export interface Totals { lines: Array<LineInput & { totalPaise: number }>; subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number }

// Total = Subtotal - Discount + Tax. Tax (basis points) is charged on the discounted amount, rounded half up to the paisa.
export function computeTotals(lines: LineInput[], discountPaise = 0, taxRateBp = 0): Totals {
  const out = lines.map((l) => ({ ...l, totalPaise: l.qty * l.unitPaise }));
  const subtotalPaise = out.reduce((t, l) => t + l.totalPaise, 0);
  const base = Math.max(0, subtotalPaise - discountPaise);
  const taxPaise = Math.floor((base * taxRateBp + 5000) / 10000);
  return { lines: out, subtotalPaise, discountPaise, taxPaise, totalPaise: base + taxPaise };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n: number) => (n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const below1000 = (n: number) => `${n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${below100(n % 100)}`;
function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  for (const [div, name] of [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']] as const) {
    const q = Math.floor(n / div);
    if (q) parts.push(`${wholeInWords(q)} ${name}`);
    n %= div;
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
// 500000 -> "Five Thousand Rupees Only"; 125050 -> "One Thousand Two Hundred Fifty Rupees and Fifty Paise Only". Indian grouping (lakh, crore).
export function amountInWords(paise: number): string | null {
  if (!Number.isInteger(paise) || paise < 0 || paise > MAX_PAISE) return null;
  const r = Math.floor(paise / 100); const p = paise % 100;
  return `${wholeInWords(r)} Rupee${r === 1 ? '' : 's'}${p ? ` and ${wholeInWords(p)} Paise` : ''} Only`;
}

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'void';
export function paymentStatus(invoiceStatus: string, totalPaise: number, paidPaise: number): PaymentStatus {
  if (invoiceStatus === 'void') return 'void';
  if (paidPaise <= 0) return totalPaise === 0 ? 'paid' : 'unpaid';
  return paidPaise >= totalPaise ? 'paid' : 'partial';
}
