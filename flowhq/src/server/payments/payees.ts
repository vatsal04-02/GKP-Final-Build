// Which doctor's UPI QR a patient is shown (owner instruction, 2 Nov 2026). Each doctor has their own account and QR image:
//   09:00 - 12:59 clinic time  -> Dr. Mahesh Tiwari's QR     (morning session)
//   16:00 - 19:59 clinic time  -> Dr. Sandeep Tiwari's QR    (evening session)
// The choice is made ONCE, when the payment request is created, from the real clock; it is stored on the payment (Payee_Key) so the QR the patient sees later, the check of the
// screenshot's receiver name and the staff screen all refer to the same account. Outside both windows (lunch break, night) the booked doctor's QR is used, so there is always one.
// `name` is the receiver name the payment app shows for that QR (what a screenshot must say). The images are the originals the owner supplied, unaltered.
import { localParts } from '../time';

export type PayeeKey = 'mahesh' | 'sandeep';
export interface Payee { key: PayeeKey; doctorId: string; doctorName: string; name: string; file: string }
export const PAYEES: Record<PayeeKey, Payee> = {
  mahesh: { key: 'mahesh', doctorId: 'DR-001', doctorName: 'Dr. Mahesh Tiwari', name: 'Mahesh Tiwari', file: 'qr-dr-mahesh-tiwari.jpg' },
  sandeep: { key: 'sandeep', doctorId: 'DR-002', doctorName: 'Dr. Sandeep Tiwari', name: 'Sandeep Kumar', file: 'qr-dr-sandeep-tiwari.jpg' },
};
export const PAYEE_KEYS = Object.keys(PAYEES) as PayeeKey[];
export const isPayeeKey = (v: unknown): v is PayeeKey => typeof v === 'string' && v in PAYEES;

/** The account to pay at this moment. `bookedDoctorId` is only the tie-break outside the two session windows. */
export function pickPayee(nowMs: number, tz: string, bookedDoctorId?: string | null): Payee {
  const h = localParts(nowMs, tz).h;
  if (h >= 9 && h < 13) return PAYEES.mahesh;
  if (h >= 16 && h < 20) return PAYEES.sandeep;
  return PAYEE_KEYS.map((k) => PAYEES[k]).find((p) => p.doctorId === bookedDoctorId) || (h >= 13 && h < 16 ? PAYEES.sandeep : PAYEES.mahesh);   // no booked doctor known: the next session's doctor
}
