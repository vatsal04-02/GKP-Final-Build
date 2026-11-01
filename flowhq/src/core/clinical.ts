// Shapes shared by the server and the clinical screens: patient register, prescriptions, invoices, payments, visits.
import type { PaymentStatus } from './money';

export const SEXES = ['Male', 'Female', 'Other'] as const;
export const PATIENT_STATUSES = ['Active', 'Completed', 'Inactive'] as const;
export const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque', 'Other'] as const;
export const VISIT_STATUSES = ['Attended', 'Missed', 'Cancelled'] as const;
export type Sex = (typeof SEXES)[number];
export type PatientStatus = (typeof PATIENT_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export interface Patient {
  patientId: string; serialNo: number; name: string; phone: string; address: string; age: string; sex: Sex | ''; referredBy: string; occupation: string;
  mainComplaint: string; registeredOn: string | null; status: PatientStatus; followUpOn: string | null; sourceLeadId: string; notes: string; createdAt: string | null;
}
export interface PatientRow extends Patient { billedPaise: number; paidPaise: number; outstandingPaise: number; latestVisit: string | null; attendance?: Record<string, VisitStatus> }
export interface PatientList { rows: PatientRow[]; total: number; page: number; pageSize: number; totals: { billedPaise: number; paidPaise: number; outstandingPaise: number } }

export interface RxImage { imageId: string; rxId: string; mime: string; bytes: number; caption: string; createdAt: string | null }
export interface Prescription {
  rxId: string; version: number; patientId: string; patientName: string; rxDate: string | null; treatingPhysio: string; bp: string; vitals: string; history: string; examination: string;
  diagnosis: string; treatmentPlan: string; exercises: string; advice: string; followUpOn: string | null; createdAt: string | null; createdBy: string; images: RxImage[];
}
export type PrescriptionInput = Omit<Prescription, 'rxId' | 'version' | 'patientName' | 'createdAt' | 'createdBy' | 'images'> & { rxId?: string; baseVersion?: number };

export interface InvoiceLine { lineNo: number; description: string; qty: number; unitPaise: number; totalPaise: number }
export interface Payment { paymentId: string; invoiceNo: string; patientId: string; paidOn: string | null; amountPaise: number; method: PaymentMethod; reference: string; notes: string; voided: boolean; voidReason: string; createdAt: string | null; createdBy: string }
export interface Invoice {
  invoiceNo: string; patientId: string; patientName: string; date: string | null; status: 'issued' | 'void'; subtotalPaise: number; discountPaise: number; taxLabel: string; taxRateBp: number; taxPaise: number;
  totalPaise: number; paidPaise: number; balancePaise: number; paymentStatus: PaymentStatus; notes: string; voidReason: string; createdAt: string | null; createdBy: string; lines: InvoiceLine[]; payments: Payment[];
}
export interface InvoiceInput { patientId: string; doctor?: string; date: string; lines: Array<{ description: string; qty: number; unitPaise: number }>; discountPaise: number; applyTax: boolean; notes: string; idemKey: string;
  payment?: { amountPaise: number; method: PaymentMethod; reference: string; paidOn: string } }

export interface Visit { patientId: string; date: string; status: VisitStatus; notes: string }
export interface VisitWeek { weekStart: string; days: string[]; rows: Array<{ patientId: string; name: string; phone: string; cells: Record<string, { status: VisitStatus; notes: string } | null> }> }

// ---- staff attendance (the clinic's own people, not patients). Stored in the optional Staff_Attendance table.
export const STAFF_STATUSES = ['Present', 'Absent', 'Half day', 'Leave'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export interface StaffMark { status: StaffStatus; notes: string }   // no clock times: a day is only Present, Absent, Half day or Leave
export interface StaffWeek {
  weekStart: string; days: string[]; today: string;
  canMarkOthers: boolean;                                          // false for a doctor's own login: it sees and marks only itself
  canManageTeam: boolean;                                          // add / remove people by name (admin and front desk)
  lockPasswordSet: boolean;                                        // false: marked days are locked for everyone until an admin sets the edit password
  canSetLockPassword: boolean;                                     // admins only
  // former: no longer on the team list, kept because they have marks in this week. removable: someone added by name on the page (logins and doctors are not)
  rows: Array<{ key: string; name: string; isMe: boolean; former: boolean; removable: boolean; cells: Record<string, StaffMark | null> }>;
}
export interface StaffMonth {
  month: string;   // YYYY-MM
  rows: Array<{ key: string; name: string; present: number; halfDay: number; absent: number; leave: number }>;
}
// A day that already has a mark is locked: changing or clearing it needs editPassword (the first mark of a day does not)
export interface StaffMarkInput { staffKey: string; date: string; status: StaffStatus | null; notes?: string; editPassword?: string }
export interface StaffMember { key: string; name: string }

export interface PatientProfile { patient: PatientRow; prescriptions: Prescription[]; invoices: Invoice[]; payments: Payment[]; visits: Visit[] }

export interface ClinicProfile {
  name: string; tagline: string; address: string; phones: string[]; timings: string; runBy: string;
  clinicians: Array<{ name: string; qualifications: string; regNo: string; mobile: string }>;
  tax: { label: string; ratePercent: number } | null;
}

// The doctor's overview for the dashboard (computed from the clinic records; nothing here is stored).
// Every tile: its value for the chosen range, the same measure for the period just before it (null when the records
// do not reach back that far, or the measure has no history), and one value per day for the last 7 days.
export type TileKey = 'seen' | 'followUps' | 'active' | 'newPatients' | 'prescriptions' | 'collected' | 'outstanding' | 'visits';
export interface DoctorTile { value: number; previous: number | null; series: number[] }
export interface DoctorSummary {
  today: string; days: number; seriesDays: string[];
  tiles: Record<TileKey, DoctorTile>;
  collectedTodayPaise: number;
  followUps: Array<{ patientId: string; name: string; phone: string; complaint: string; followUpOn: string; overdueDays: number }>;
  todaysVisits: Array<{ patientId: string; name: string; status: VisitStatus }>;
  recentPrescriptions: Array<{ rxId: string; patientId: string; patientName: string; rxDate: string | null; diagnosis: string }>;
  owing: Array<{ patientId: string; name: string; outstandingPaise: number }>;
  attendance: Array<{ date: string; attended: number }>;
  byDoctor?: Array<{ name: string; outstandingPaise: number; collectedPaise: number; prescriptions: number }>;   // admin only, when not looking at one doctor
}
