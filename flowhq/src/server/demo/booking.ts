// DEMO DATA for the Schedule page (made up; memory only; never written anywhere). The three demo doctors are the demo clinic's own staff names, so the
// demo's older appointments (which only know the Physio name) line up with real doctors. AI booking is OFF, like a real clinic before cutover.
import type { GristRecord } from '../grist';
import { dateIn } from '../records/ids';

const rows = (list: Array<Record<string, unknown>>): GristRecord[] => list.map((f, i) => ({ id: i + 1, fields: f as GristRecord['fields'] }));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function demoBookingTables(nowMs: number, existing: GristRecord[]): Record<string, GristRecord[]> {
  const sec = Math.floor(nowMs / 1000); const dayStart = Math.floor((sec + 19800) / 86400) * 86400 - 19800;   // today 00:00 IST
  const at = (dayOffset: number, h: number, m = 0) => dayStart + dayOffset * 86400 + h * 3600 + m * 60;
  const doctors = [
    { Doctor_ID: 'DR-001', Name: 'Dr. Mehta', Qualification: 'MPT (PT)', Default_Shift: 'Morning', Active: true },
    { Doctor_ID: 'DR-002', Name: 'Dr. Rao', Qualification: 'MPT (PT)', Default_Shift: 'Evening', Active: true },
    { Doctor_ID: 'DR-003', Name: 'Dr. Iyer', Qualification: 'MPT (PT)', Default_Shift: 'Morning', Active: true, Notes: 'No booking hours yet' },
  ];
  const schedules = DAYS.flatMap((d, i) => [
    { Schedule_ID: `SCH-${String(i * 2 + 1).padStart(3, '0')}`, Doctor_ID: 'DR-001', Weekday: d, Shift: 'Morning', Start_Time: '09:00', End_Time: '13:00', Active: true, Is_Override: false },
    { Schedule_ID: `SCH-${String(i * 2 + 2).padStart(3, '0')}`, Doctor_ID: 'DR-002', Weekday: d, Shift: 'Evening', Start_Time: '16:00', End_Time: '20:00', Active: true, Is_Override: false },
  ]);
  const config = [
    ['booking_enabled', 'off'], ['timezone', 'Asia/Kolkata'], ['slot_minutes', '30'], ['buffer_minutes', '0'], ['capacity', '1'], ['min_notice_minutes', '120'], ['cancel_min_notice_minutes', '0'],
    ['max_advance_days', ''], ['operating_days', 'Mon-Sat'], ['open_windows', '09:00-13:00, 16:00-20:00'], ['shift_morning_enabled', 'on'], ['shift_evening_enabled', 'on'],
  ].map(([Key, Value]) => ({ Key, Value }));
  const nextId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  // four new-style appointments (two by the AI, two by staff) on the next working days, so the page has something to show
  const sample = (n: number, uid: string, dayOffset: number, h: number, m: number, doc: [string, string], name: string, phone: string, source: string, stage: string, reason: string) => ({
    id: nextId + n, fields: { Booking_UID: uid, Service: 'Physiotherapy', Physio: doc[1], Start: at(dayOffset, h, m), End: at(dayOffset, h, m + 30), Status: 'Booked', Patient_Name: name, Patient_Phone: phone, Doctor_ID: doc[0],
      Shift: h < 14 ? 'Morning' : 'Evening', Slot_Key: `${doc[0]}|DEMO|${h}:${m}`, Booking_Source: source, Appt_Stage: stage, Reason: reason, Created_At: sec - 3600 * n, Updated_At: sec - 3600 * n, Created_By: source === 'Staff' ? 'staff@flowhq.demo' : 'n8n-demo' } as GristRecord['fields'],
  });
  const sampleAppts: GristRecord[] = [
    sample(1, 'wa-GKA-000001', 1, 9, 30, ['DR-001', 'Dr. Mehta'], 'Demo Patient A', '+919000010001', 'WhatsApp AI', 'Confirmed', 'Knee pain'),
    sample(2, 'GKA-000002', 1, 10, 0, ['DR-001', 'Dr. Mehta'], 'Demo Patient B', '+919000010002', 'Staff', 'Pending confirmation', 'Back pain, first visit'),
    sample(3, 'wa-GKA-000003', 2, 16, 30, ['DR-002', 'Dr. Rao'], 'Demo Patient C', '+919000010003', 'WhatsApp AI', 'Confirmed', 'Shoulder stiffness'),
    sample(4, 'GKA-000004', 2, 17, 0, ['DR-002', 'Dr. Rao'], 'Demo Patient D', '+919000010004', 'Staff', 'Confirmed', 'Follow-up'),
  ];
  const doctorRows = rows(doctors); const blockRows = rows([{ Block_ID: 'BLK-000001', Kind: 'Doctor leave', Doctor_ID: 'DR-002', Date_From: dateIn(new Date((dayStart + 5 * 86400 + 19800) * 1000).toISOString().slice(0, 10)), Date_To: dateIn(new Date((dayStart + 5 * 86400 + 19800) * 1000).toISOString().slice(0, 10)), Reason: 'Conference (demo)', Active: true }]);
  return {
    Doctors: doctorRows, Doctor_Schedules: rows(schedules), Booking_Config: rows(config), Closures_Blocks: blockRows, Booking_Audit: [], Reminder_Consent: [], Reminder_Consent_Log: [],
    Appointments: [...existing, ...sampleAppts],
  };
}
