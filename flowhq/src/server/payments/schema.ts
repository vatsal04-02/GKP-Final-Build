// UPI payment tables (docs/payments.md). ADDITIVE: three new tables; Appointments and the booking tables are never changed.
// Payment status is stored HERE, independently of the appointment status. A payment row points at its appointment by Booking_UID.
import { gristField, type ColType } from '../records/schema';

export const PT = { payments: 'Booking_Payments', events: 'Payment_Events', files: 'Payment_Files' } as const;

// A screenshot or an OCR result is never PAID. PAID is set only by a staff approval (staff_bank_statement) or a signed provider event (provider_webhook).
export const PAYMENT_STATUSES = ['PENDING_PAYMENT', 'SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'PAID', 'REJECTED', 'REFUNDED', 'EXPIRED', 'CANCELLED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const OPEN_STATUSES: PaymentStatus[] = ['PENDING_PAYMENT', 'SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'REJECTED'];   // the slot is still held
export const CHANNELS = ['website', 'whatsapp'] as const;
export const METHODS = ['staff_bank_statement', 'provider_webhook'] as const;

const STAMP: Array<[string, ColType]> = [['Created_At', 'DateTime'], ['Updated_At', 'DateTime']];

export const PAYMENT_TABLES: Record<string, Array<[string, ColType]>> = {
  Booking_Payments: [
    ['Payment_ID', 'Text'], ['Booking_UID', 'Text'], ['Channel', [...CHANNELS]], ['Patient_Name', 'Text'], ['Patient_Phone', 'Text'],
    ['Amount_Paise', 'Int'], ['Currency', 'Text'], ['Status', [...PAYMENT_STATUSES]], ['Expires_At', 'DateTime'], ['Idem_Key', 'Text'],
    ['UTR', 'Text'], ['UTR_Source', ['patient', 'ocr', 'staff']], ['Screenshot_Count', 'Int'], ['Screenshot_Ref', 'Text'], ['Screenshot_Hash', 'Text'],
    ['OCR_Amount_Paise', 'Int'], ['OCR_UTR', 'Text'], ['OCR_Txn_At', 'DateTime'], ['OCR_Payee', 'Text'], ['OCR_Payer', 'Text'], ['OCR_Status', 'Text'], ['OCR_Confidence', 'Text'], ['Flags', 'Text'],
    ['Verification_Method', [...METHODS]], ['Received_Paise', 'Int'], ['Reviewed_By', 'Text'], ['Reviewed_At', 'DateTime'], ['Review_Note', 'Text'],
    ['Refunded_At', 'DateTime'], ['Refunded_By', 'Text'], ['Refund_Note', 'Text'],
    ['Request_Sent', 'Bool'], ['Notified_Status', 'Text'], ['Notify_Attempts', 'Int'], ['Last_Event_At', 'DateTime'], ...STAMP,
  ],
  // Append-only history. Nothing in FLOW HQ updates or deletes a row here.
  Payment_Events: [['Event_ID', 'Text'], ['At', 'DateTime'], ['Payment_ID', 'Text'], ['Booking_UID', 'Text'], ['Actor', 'Text'], ['Action', 'Text'], ['From_Status', 'Text'], ['To_Status', 'Text'], ['Outcome', ['ok', 'failed', 'rejected']], ['Detail', 'Text']],
  // One row per stored screenshot. The image itself lives on the persistent volume (never in Grist, never in a public path).
  Payment_Files: [['File_Ref', 'Text'], ['Payment_ID', 'Text'], ['SHA256', 'Text'], ['Bytes', 'Int'], ['Mime', 'Text'], ['Source', ['website', 'whatsapp']], ['At', 'DateTime'], ['Meta_Media_ID', 'Text']],
};
export const PAYMENT_SETTING_KEYS = ['payments_enabled', 'payee_authorized', 'consultation_fee_inr', 'payment_expiry_minutes', 'payment_review_hold_minutes', 'payee_name', 'payee_authorization_note'] as const;
export const paymentColumnDefs = (cols: Array<[string, ColType]>) => cols.map(([id, t]) => ({ id, fields: gristField(id, t) }));
