// The appointment-booking tables, exactly as in grist/booking-schema.md (tests keep the two in step).
// Five NEW tables, plus ADDITIVE columns on the EXISTING Appointments table (the one Cal.com / W4 / the Bookings page already use):
// Appointments stays the single appointments table; nothing is renamed, retyped or removed.
import { gristField, type ColType } from '../records/schema';

export const BT = { doctors: 'Doctors', schedules: 'Doctor_Schedules', config: 'Booking_Config', blocks: 'Closures_Blocks', audit: 'Booking_Audit', appointments: 'Appointments', consent: 'Reminder_Consent', consentLog: 'Reminder_Consent_Log' } as const;

export const SHIFT_CHOICES = ['Morning', 'Evening'];
export const WEEKDAY_CHOICES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // Mon = 1 ... Sun = 7 in the engine
export const SOURCE_CHOICES = ['WhatsApp AI', 'Staff', 'Cal.com', 'Other'];
// Only meaningful while Appointments.Status is Booked / Rescheduled. Status itself is untouched (W4-W9 filter on it).
export const STAGE_CHOICES = ['Pending confirmation', 'Confirmed', 'Checked in'];
export const BLOCK_KIND_CHOICES = ['Clinic closure', 'Doctor leave', 'Blocked time'];
export const AUDIT_SOURCE_CHOICES = ['Staff', 'API', 'System'];
export const CONSENT_VALUES = ['Yes', 'No', 'Unknown'];
// Where a recorded answer came from. A patient messaging first, or the website tick-box, are NOT sources: they are not reminder consent.
export const CONSENT_SOURCES = ['Signed registration form', 'Told staff in person', 'Told staff by phone', 'Patient replied on WhatsApp (reviewed by staff)', 'Patient withdrew', 'Admin correction', 'Imported with evidence'];
export const CONSENT_KINDS = ['recorded', 'corrected', 'revoked'];

const STAMP: Array<[string, ColType]> = [['Updated_At', 'DateTime'], ['Updated_By', 'Text']];
// The id of the last audited operation that changed the row. It is written in the SAME Grist write as the change, so after a crash the row itself proves
// whether an audited operation was applied (see outbox.ts). Never shown to patients; holds no personal data.
const AUDIT: Array<[string, ColType]> = [['Audit_ID', 'Text']];

// New tables
export const BOOKING_TABLES: Record<string, Array<[string, ColType]>> = {
  Doctors: [['Doctor_ID', 'Text'], ['Name', 'Text'], ['Qualification', 'Text'], ['Default_Shift', SHIFT_CHOICES], ['Active', 'Bool'], ['Notes', 'Text'], ['Created_At', 'DateTime'], ...STAMP, ...AUDIT],
  // One row = one doctor, one weekday, one shift window. Blank Slot_Minutes / Buffer_Minutes / Capacity = use Booking_Config.
  // Blank Effective_From / Effective_To = no limit. Is_Override rows replace the normal rows for that shift (and are the ONLY way a doctor works the other shift).
  Doctor_Schedules: [['Schedule_ID', 'Text'], ['Doctor_ID', 'Text'], ['Weekday', WEEKDAY_CHOICES], ['Shift', SHIFT_CHOICES], ['Start_Time', 'Text'], ['End_Time', 'Text'],
    ['Slot_Minutes', 'Int'], ['Buffer_Minutes', 'Int'], ['Capacity', 'Int'], ['Effective_From', 'Date'], ['Effective_To', 'Date'], ['Active', 'Bool'], ['Is_Override', 'Bool'], ['Override_Reason', 'Text'], ...STAMP, ...AUDIT],
  Booking_Config: [['Key', 'Text'], ['Value', 'Text'], ...STAMP, ...AUDIT],
  // Clinic closures, doctor leave and blocked time ranges. Blank Doctor_ID = every doctor; blank Shift = both shifts; blank Start_Time / End_Time = the whole day.
  Closures_Blocks: [['Block_ID', 'Text'], ['Kind', BLOCK_KIND_CHOICES], ['Doctor_ID', 'Text'], ['Shift', SHIFT_CHOICES], ['Date_From', 'Date'], ['Date_To', 'Date'], ['Start_Time', 'Text'], ['End_Time', 'Text'],
    ['Reason', 'Text'], ['Active', 'Bool'], ['Created_At', 'DateTime'], ['Created_By', 'Text'], ...AUDIT],
  // One row per phone: the CURRENT answer to "may we send automated WhatsApp appointment / follow-up reminders to this number?". No row = Unknown.
  // n8n (W5 / W12 / W15) reads this table.
  Reminder_Consent: [['Consent_ID', 'Text'], ['Phone', 'Text'], ['Patient_ID', 'Text'], ['Reminder_Consent', CONSENT_VALUES], ['Reminder_Consent_At', 'DateTime'], ['Reminder_Consent_Source', CONSENT_SOURCES], ['Evidence_Ref', 'Text'], ['Evidence_Date', 'Date'],
    ['Form_Version', 'Text'], ['Recorded_By', 'Text'], ['Previous_Value', CONSENT_VALUES], ['Updated_At', 'DateTime'], ...AUDIT],
  // Append-only history of every change (never edited or deleted). The log is the record of truth; Reminder_Consent is rebuilt from it after a crash.
  Reminder_Consent_Log: [['Log_ID', 'Text'], ['Consent_ID', 'Text'], ['Phone', 'Text'], ['Value', CONSENT_VALUES], ['Previous_Value', CONSENT_VALUES], ['At', 'DateTime'], ['Source', CONSENT_SOURCES], ['Evidence_Ref', 'Text'], ['Evidence_Date', 'Date'],
    ['Form_Version', 'Text'], ['Actor', 'Text'], ['Kind', CONSENT_KINDS], ['Note', 'Text'], ...AUDIT],
  Booking_Audit: [['At', 'DateTime'], ['Actor', 'Text'], ['Source', AUDIT_SOURCE_CHOICES], ['Action', 'Text'], ['Record', 'Text'], ['Outcome', ['ok', 'rejected']], ['Reason', 'Text'], ['Detail', 'Text'], ...AUDIT],   // Audit_ID is UNIQUE by convention: the idempotent flush never inserts one twice
};

// Added to the EXISTING Appointments table (never created by us: it comes from the Clinic CRM template).
// Reused as they are: Booking_UID (the booking reference), Lead, Service, Physio (the doctor's name), Start, End, Status.
export const APPOINTMENT_EXTRA: Array<[string, ColType]> = [
  ['Patient_ID', 'Text'],            // the Clinic Records patient, when there is one (no patient record is ever created from here)
  ['Patient_Name', 'Text'], ['Patient_Phone', 'Text'],   // snapshot, so a booking with no Lead (a walk-in) still names the patient
  ['Doctor_ID', 'Text'], ['Shift', SHIFT_CHOICES], ['Slot_Key', 'Text'],   // Slot_Key = doctorId|YYYY-MM-DD|HH:MM
  ['Booking_Source', SOURCE_CHOICES], ['Appt_Stage', STAGE_CHOICES], ['Reason', 'Text'], ['Idem_Key', 'Text'],
  ['Cancel_Reason', 'Text'], ['Created_At', 'DateTime'], ['Updated_At', 'DateTime'], ['Created_By', 'Text'], ...AUDIT,
];

export const bookingColNames = (t: string): string[] => (t === BT.appointments ? APPOINTMENT_EXTRA : BOOKING_TABLES[t] || []).map(([n]) => n);
export const bookingColumnDefs = (cols: Array<[string, ColType]>) => cols.map(([id, t]) => ({ id, fields: gristField(id, t) }));
