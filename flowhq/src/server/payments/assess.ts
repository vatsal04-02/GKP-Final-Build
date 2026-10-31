// Pure rules for payment screenshots (no I/O, fully tested). NOTHING here can produce PAID: assess() only returns flags for the staff reviewer.
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type ImageKind = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/** The real type of an upload, from its first bytes (the declared type is never trusted). SVG, PDF, GIF and everything else are refused. */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** Editing software leaves its name in the first bytes of a JPEG/PNG. A real phone screenshot does not carry it. A hint for the reviewer, not proof. */
export function editedBySoftware(b: Buffer): boolean { return /photoshop|adobe|gimp|canva|picsart|snapseed|pixlr|paint\.net|lightroom/i.test(b.subarray(0, 65536).toString('latin1')); }

/** "₹500", "Rs. 500.00", 500, "500.5" -> paise (integer) or null. Never rounds: 500.505 is not an amount. */
export function toPaise(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[,\s]/g, '').replace(/^(?:₹|rs\.?|inr)/i, '').match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0) : null;
}
/** A UPI reference (UTR / transaction id). The usual one is 12 digits; anything else is kept but flagged. */
export function cleanUtr(v: unknown): string { return String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40); }
export const utrLooksValid = (u: string) => /^\d{12}$/.test(u);

export interface Extraction { amount?: unknown; utr?: unknown; txn_time?: unknown; payee?: unknown; payer?: unknown; status?: unknown; reference?: unknown; confidence?: unknown; looks_edited?: unknown; is_payment_screenshot?: unknown }
export interface AssessInput {
  extraction: Extraction | null; feePaise: number; payeeName: string; createdAtSec: number; nowSec: number;
  patientUtr?: string; utrUsedElsewhere: boolean; imageDuplicate: boolean; edited: boolean; ocrError?: string;
}
export interface Assessment { flags: string[]; amountPaise: number | null; utr: string; utrSource: 'patient' | 'ocr' | ''; txnAtSec: number | null; payee: string; payer: string; status: string; confidence: number | null; consistent: boolean }

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export function payeeMatches(seen: unknown, want: string): boolean { const s = norm(seen); const tokens = norm(want).split(' ').filter((x) => x.length > 2); return !!s && tokens.length > 0 && tokens.every((x) => s.includes(x)); }
export function parseTxnTime(v: unknown): number | null { if (v === null || v === undefined || v === '') return null; const ms = Date.parse(String(v)); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; }

export function assess(i: AssessInput): Assessment {
  const flags: string[] = []; const x = i.extraction;
  if (i.imageDuplicate) flags.push('duplicate_image');
  if (i.edited) flags.push('edited_by_software');
  if (!x) { flags.push('ocr_unavailable'); if (i.ocrError) flags.push(`ocr_error:${i.ocrError.slice(0, 40)}`); }
  const amount = x ? toPaise(x.amount) : null;
  const ocrUtr = x ? cleanUtr(x.utr) : ''; const patientUtr = cleanUtr(i.patientUtr);
  if (x) {
    if (x.is_payment_screenshot === false) flags.push('not_a_payment_screenshot');
    if (x.looks_edited === true) flags.push('ai_suspects_edit');
    if (amount === null) flags.push('amount_missing'); else if (amount !== i.feePaise) flags.push('amount_mismatch');
    if (!ocrUtr) flags.push('utr_missing'); else if (!utrLooksValid(ocrUtr)) flags.push('utr_format');
    if (patientUtr && ocrUtr && patientUtr !== ocrUtr) flags.push('utr_differs_from_patient');
    if (!payeeMatches(x.payee, i.payeeName)) flags.push('payee_mismatch');
    if (String(x.status ?? '').trim().toLowerCase() !== 'success') flags.push('status_not_success');
  }
  const txn = x ? parseTxnTime(x.txn_time) : null;
  if (x && txn === null) flags.push('time_missing'); else if (txn !== null && (txn < i.createdAtSec - 300 || txn > i.nowSec + 600)) flags.push('time_outside_window');
  const conf = x && typeof x.confidence === 'number' && Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : null;
  if (x && (conf === null || conf < 0.7)) flags.push('low_confidence');
  const utr = ocrUtr || patientUtr;
  if (utr && i.utrUsedElsewhere) flags.push('utr_already_used');
  return { flags, amountPaise: amount, utr, utrSource: ocrUtr ? 'ocr' : patientUtr ? 'patient' : '', txnAtSec: txn, payee: x ? String(x.payee ?? '').slice(0, 120) : '', payer: x ? String(x.payer ?? '').slice(0, 120) : '', status: x ? String(x.status ?? '').slice(0, 30) : '', confidence: conf, consistent: flags.length === 0 };
}

/** The wording a patient sees for each state. It never reveals flags, UTRs or what staff are checking. */
export const PATIENT_STATUS: Record<string, { code: string; text: string }> = {
  PENDING_PAYMENT: { code: 'awaiting_payment', text: 'Waiting for your payment. Your time is held for you until it expires.' },
  SCREENSHOT_RECEIVED: { code: 'received', text: 'We received your payment screenshot.' },
  REVIEW_REQUIRED: { code: 'under_review', text: 'Our team is checking your payment. We will confirm your appointment once the payment is verified.' },
  PAID: { code: 'confirmed', text: 'Payment verified. Your appointment is confirmed.' },
  REJECTED: { code: 'not_verified', text: 'We could not verify this payment. Please send a clear screenshot of the successful payment, or contact the clinic.' },
  REFUNDED: { code: 'refunded', text: 'Your payment has been refunded.' },
  EXPIRED: { code: 'expired', text: 'The payment time ran out and the held time was released. Please book again.' },
  CANCELLED: { code: 'cancelled', text: 'This booking was cancelled.' },
};
